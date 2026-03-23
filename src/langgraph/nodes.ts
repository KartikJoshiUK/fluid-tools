import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "langchain";
import MessagesState from './state';
import { END, START, StateGraph } from '@langchain/langgraph';
import { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import { Model, PendingToolCall, ToolConfirmationConfig } from './types';
import { RAGConfig, RAGDocument, RAGProvider } from '../types/rag.types';
import { DEFAULT_SYSTEM_INSTRUCTIONS } from './constants';
import { logger } from '../utils';
import { Tools } from './tool';
import { RunnableConfig } from "@langchain/core/runnables";

type ContentFilterOutput = (toolName: string, response: string) => string | Promise<string>;

const getAgent = (
  model: Model,
  toolObj: Tools,
  memory: BaseCheckpointSaver,
  getSystemInstructions: () => string = () => DEFAULT_SYSTEM_INSTRUCTIONS,
  debug: boolean = false,
  contentFilterOutput: ContentFilterOutput = async (_toolName, response) => response,
  getAuthTokenForThread: (threadId: string) => string | undefined = () => undefined,
  confirmationConfig?: ToolConfirmationConfig,
  ragConfig?: RAGConfig,
  ragProvider?: RAGProvider // MongoRAGProvider implements this interface
) => {
  // Tools that require human confirmation
  const modes = confirmationConfig?.mode || "manual";
  const explicitRequire = new Set(confirmationConfig?.requireConfirmation || []);
  const explicitExclude = new Set(confirmationConfig?.excludeTools || []);
  const requireMethods = new Set(
    confirmationConfig?.requireMethods || ["POST", "PUT", "PATCH", "DELETE"]
  );

  const checkRequiresConfirmation = (toolName: string): boolean => {
    if (modes === "none") return false;
    if (explicitExclude.has(toolName)) return false;
    if (explicitRequire.has(toolName)) return true;

    if (modes === "restrictive") {
      const tool = toolObj.getToolByName()[toolName];
      // Get method from tool metadata if it exists (set by converters)
      const method = (tool?.metadata?.method as string | undefined)?.toUpperCase();

      if (requireMethods.has("ALL")) return true;
      if (method && requireMethods.has(method)) return true;
    }

    return false;
  };

  const isHitlEnabled = modes !== "none" && (
    modes === "restrictive" ||
    explicitRequire.size > 0
  );

  // Helper function to get the latest user message
  function getLatestUserMessage(state: typeof MessagesState.State): string {
    // Find the most recent human message
    for (let i = state.messages.length - 1; i >= 0; i--) {
      const message = state.messages[i];
      if (HumanMessage.isInstance(message)) {
        return message.content as string;
      }
    }
    return ""; // Fallback if no user message found
  }

  // RAG Router Node - LLM-based decision on whether to use RAG
  async function ragRouter(state: typeof MessagesState.State) {
    logger(debug, "\n[FluidTools: RAG Router] Deciding whether to use RAG...");

    const latestUserMessage = getLatestUserMessage(state);
    if (!latestUserMessage) {
      logger(debug, "[FluidTools: RAG Router] No user message found, defaulting to no RAG");
      return {
        ragDecision: { useRag: false }
      };
    }

    const hints = ragConfig?.ragRoutingHints?.map((h, i) => `${i + 1}. ${h}`).join('\n') ?? '';
    const routingPrompt =
      `You are a routing assistant. Decide if the user's query would benefit from retrieving additional context documents.
      
      Return ONLY a JSON object with this exact format:
      {"useRag": boolean, "query": "search query", "k": number}
      
      Use RAG (useRag: true) for:
      - Questions about specific topics, products, or documentation
      - Requests for detailed information
      - Technical queries that might need context
      
      Don't use RAG (useRag: false) for:
      - General conversation
      - Simple greetings
      - Questions about the current conversation
      - Requests that don't need external context${hints ? `\n\nAdditional hints:\n${hints}` : ''}
      `;

    const routerMessages = [
      new SystemMessage(routingPrompt),
      new HumanMessage(`User query: "${latestUserMessage}"`)
    ];

    try {
      // Use the model directly for routing (can't reliably bind temperature across all model types)
      const response = await model.invoke(routerMessages);
      const content = String(response.content ?? "");

      logger(debug, "[FluidTools: RAG Router] Raw response:", content);

      // Parse JSON response
      const cleaned = content
        .trim()
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "");
      const decision = JSON.parse(cleaned) as {
        useRag?: boolean;
        query?: string;
        k?: number;
      };

      // Validate and set defaults
      const ragDecision = {
        useRag: Boolean(decision.useRag),
        query: decision.query || latestUserMessage,
        k: decision.k || ragConfig?.maxDocuments || 5
      };

      logger(debug, "[FluidTools: RAG Router] Decision:", ragDecision);
      return { ragDecision };

    } catch (error) {
      logger(debug, "[FluidTools: RAG Router] Parse error, using defaults:", error);
      // On parse failure, default to no RAG to avoid unexpected retrieval overhead.
      return {
        ragDecision: {
          useRag: false,
          query: latestUserMessage,
          k: ragConfig?.maxDocuments || 5
        }
      };
    }
  }

  // RAG Retrieve Node - Performs vector similarity search
  async function ragRetrieve(state: typeof MessagesState.State) {
    logger(debug, "\n[FluidTools: RAG Retrieve] Retrieving documents...");

    if (!state.ragDecision?.useRag) {
      logger(debug, "[FluidTools: RAG Retrieve] RAG not requested, skipping");
      return {};
    }

    if (!ragProvider) {
      logger(debug, "[FluidTools: RAG Retrieve] No RAG provider available");
      return {
        ragDocs: [],
        ragContext: ""
      };
    }

    const query = state.ragDecision.query || getLatestUserMessage(state);
    const k = state.ragDecision.k || ragConfig?.maxDocuments || 5;

    logger(debug, `[FluidTools: RAG Retrieve] Searching for "${query}" (k=${k})`);

    try {
      // Use RAG provider's searchSimilarDocuments method
      const docs: RAGDocument[] = await ragProvider.searchSimilarDocuments(query, {
        limit: k,
        threshold: ragConfig?.similarityThreshold || 0.7
      });

      // Create context string with document labels
      let ragContext = "";
      if (docs.length > 0) {
        ragContext = docs
          .map((doc, index) => `[#${index + 1}] ${doc.content}`)
          .join("\n\n");

        // Apply context window limit if configured
        if (ragConfig?.contextWindow && ragContext.length > ragConfig.contextWindow) {
          ragContext = ragContext.substring(0, ragConfig.contextWindow) + "...";
          logger(debug, `[FluidTools: RAG Retrieve] Trimmed context to ${ragConfig.contextWindow} chars`);
        }
      }

      logger(debug, `[FluidTools: RAG Retrieve] Retrieved ${docs.length} documents`);

      return {
        ragDocs: docs,
        ragContext
      };

    } catch (error) {
      logger(debug, "[FluidTools: RAG Retrieve] Error during retrieval:", error);
      return {
        ragDocs: [],
        ragContext: ""
      };
    }
  }

  async function llmCall(state: typeof MessagesState.State, config?: RunnableConfig) {
    logger(debug, "\n[FluidTools: LLM Call] Current state:", {
      messageCount: state.messages.length,
      maxToolCalls: state.maxToolCalls,
      hasRagContext: !!state.ragContext,
    });

    const runtimeTools = (config?.configurable?.tools as Tools | undefined) ?? toolObj;
    const toolsByName = runtimeTools.getToolByName(debug);
    const modelWithTools = model.bindTools(Object.values(toolsByName));

    // Build system message with RAG context if available
    let systemContent = getSystemInstructions();
    if (state.ragContext) {
      systemContent += `\n\nContext:\n${state.ragContext}`;
      logger(debug, "[FluidTools: LLM Call] Added RAG context to system message");
    }

    const enhancedSystemMessage = new SystemMessage(systemContent);
    const messages = [enhancedSystemMessage, ...state.messages];

    logger(debug, "[FluidTools: LLM Call] Sending messages to LLM:", messages.length);
    const aiMessage = await modelWithTools.invoke(messages);
    logger(debug, "[FluidTools: LLM Call] Received AI message:", {
      hasToolCalls: !!aiMessage.tool_calls?.length,
      toolCallCount: aiMessage.tool_calls?.length || 0,
    });

    return {
      messages: [aiMessage], // ✅ Only return new message - LangGraph handles merging
    };
  }

  async function toolNode(state: typeof MessagesState.State, config?: RunnableConfig) {
    logger(debug, "\n[FluidTools: Tool Node] Executing tools...");
    const lastMessage = state.messages.at(-1);
    if (lastMessage == null || !AIMessage.isInstance(lastMessage)) {
      logger(debug, "[FluidTools: Tool Node] No valid AI message found");
      return {
        messages: [],
        pendingConfirmations: [],
        awaitingConfirmation: false,
      };
    }

    const result: BaseMessage[] = [];
    const newPendingConfirmations: PendingToolCall[] = [];
    const runtimeTools = (config?.configurable?.tools as Tools | undefined) ?? toolObj;
    const toolsByName = runtimeTools.getToolByName(debug);
    const threadId = typeof config?.configurable?.thread_id === "string" ? config.configurable.thread_id : "";
    const accessToken = getAuthTokenForThread(threadId);

    // Get existing pending confirmations from state (for resume scenario)
    const existingPending: PendingToolCall[] = state.pendingConfirmations || [];
    const pendingByToolCallId = new Map<string, PendingToolCall>(
      existingPending.map((p) => [p.toolCallId, p])
    );

    for (const toolCall of lastMessage.tool_calls ?? []) {
      logger(debug, `[FluidTools: Tool Node] Checking tool: ${toolCall.name}`);

      const existingConfirmation = pendingByToolCallId.get(toolCall.id!);

      if (existingConfirmation) {
        logger(
          debug,
          `[FluidTools: Tool Node] Found existing confirmation for ${toolCall.name}: ${existingConfirmation.status}`
        );

        if (existingConfirmation.status === "approved") {
          // Tool was approved - execute it now
          logger(
            debug,
            `[FluidTools: Tool Node] Tool ${toolCall.name} was approved, executing...`
          );
          const tool = toolsByName[toolCall.name];
          if (!tool) {
            result.push(
              new ToolMessage({
                tool_call_id: toolCall.id!,
                name: toolCall.name,
                content: `Tool "${toolCall.name}" not found.`,
              })
            );
            continue;
          }
          const observation = await tool.invoke({
            ...toolCall.args,
            authToken: accessToken,
            ...runtimeTools.Config,
          });
          if (ToolMessage.isInstance(observation)) {
            const filteredContent = await contentFilterOutput(
              toolCall.name,
              String(observation.content ?? "")
            );
            observation.content = filteredContent;
          }
          result.push(observation);
          logger(debug, `✅ [toolNode] Tool ${toolCall.name} completed`);
          continue;
        } else if (existingConfirmation.status === "rejected") {
          // Tool was rejected - add rejection message
          logger(
            debug,
            `[FluidTools: Tool Node] Tool ${toolCall.name} was rejected by user`
          );
          result.push(
            new ToolMessage({
              tool_call_id: toolCall.id!,
              name: toolCall.name,
              content: `Action "${toolCall.name}" was cancelled by user.`,
            })
          );
          // Add explicit instruction for LLM to acknowledge the cancellation
          result.push(
            new HumanMessage(
              `The user declined the tool call "${toolCall.name}". Please inform them you could not complete the action.`
            )
          );
          continue;
        }
        // If still 'pending', fall through to normal processing
      }

      // Check if this tool requires confirmation
      if (checkRequiresConfirmation(toolCall.name)) {
        logger(
          debug,
          `[FluidTools: Tool Node] Tool ${toolCall.name} requires confirmation!`
        );

        // Add to pending and pause for human confirmation
        const filteredArgs = Object.fromEntries(
          Object.entries(toolCall.args || {}).filter(([key]) => key !== key.toUpperCase())
        );
        newPendingConfirmations.push({
          toolName: toolCall.name,
          toolCallId: toolCall.id!,
          args: filteredArgs,
          status: "pending",
        });
        continue;
      }

      // Execute the tool
      const tool = toolsByName[toolCall.name];
      if (!tool) {
        result.push(
          new ToolMessage({
            tool_call_id: toolCall.id!,
            name: toolCall.name,
            content: `Tool "${toolCall.name}" not found.`,
          })
        );
        continue;
      }
      const observation = await tool.invoke({
        ...toolCall.args,
        authToken: accessToken,
        ...runtimeTools.Config,
      });
      if (ToolMessage.isInstance(observation)) {
        const filteredContent = await contentFilterOutput(
          toolCall.name,
          String(observation.content ?? "")
        );
        observation.content = filteredContent;
      }
      result.push(observation);
      logger(debug, `✅ [toolNode] Tool ${toolCall.name} completed`);
    }

    // If we have NEW pending confirmations, pause the graph
    if (newPendingConfirmations.length > 0) {
      logger(
        debug,
        `[FluidTools: Tool Node] Pausing for ${newPendingConfirmations.length} confirmations`
      );
      return {
        messages: result,
        pendingConfirmations: newPendingConfirmations,
        awaitingConfirmation: true,
      };
    }

    logger(debug, `[FluidTools: Tool Node] Returning ${result.length} tool messages`);
    return {
      messages: result,
      pendingConfirmations: [],
      awaitingConfirmation: false,
    };
  }
  async function shouldContinue(state: typeof MessagesState.State) {
    logger(debug, "\n[FluidTools: Execution] Deciding next step...");

    const lastMessage = state.messages.at(-1);
    if (lastMessage == null || !AIMessage.isInstance(lastMessage)) {
      logger(debug, "[FluidTools: Execution] No AI message, ending");
      return END;
    }

    // Count how many tool calls we've made so far
    const toolCallCount = state.messages.filter((m: BaseMessage) =>
      ToolMessage.isInstance(m)
    ).length;

    const maxToolCalls = state.maxToolCalls || 10;
    logger(
      debug,
      `[FluidTools: Execution] Tool calls: ${toolCallCount}/${maxToolCalls}`
    );

    // Stop if we've hit the recursion limit
    if (toolCallCount >= maxToolCalls) {
      logger(
        true,
        `Reached maximum tool call limit (${maxToolCalls}). Stopping to prevent infinite loops.`
      );
      return END;
    }

    // If the LLM makes a tool call, then perform an action
    if (lastMessage.tool_calls?.length) {
      logger(
        debug,
        `[FluidTools: Execution] Continuing to toolNode (${lastMessage.tool_calls.length} tools)`
      );
      return "toolNode";
    }

    // Otherwise, we stop (reply to the user)
    logger(debug, "[FluidTools: Execution] No more tool calls, ending");
    return END;
  }

  async function awaitConfirmationNode(state: typeof MessagesState.State) {
    logger(
      debug,
      "\n[FluidTools: HITL] Graph paused for human confirmation"
    );
    logger(debug, "Pending confirmations:", state.pendingConfirmations);

    return {};
  }

  /** Trims messages to keep context window manageable */
  async function trimMessagesNode(state: typeof MessagesState.State) {
    const limit = state.maxMessages || 50;
    if (state.messages.length <= limit) return {};

    logger(debug, `[FluidTools: Trimming] Limit reached (${state.messages.length}/${limit}). Trimming history...`);
    
    // Always keep at least the last 'limit' messages
    // Note: In a real scenario we might want to ensure we don't trim middle of a tool call/response pair
    // but for simple history trimming this is standard.
    return {
      messages: state.messages.slice(-limit)
    };
  }

  // Conditional edge function for RAG router
  function ragRouterDecision(state: typeof MessagesState.State) {
    if (state.ragDecision?.useRag) {
      logger(debug, "🧭 [ragRouterDecision] Routing to ragRetrieve");
      return "ragRetrieve";
    } else {
      logger(debug, "🧭 [ragRouterDecision] Routing directly to llmCall");
      return "llmCall";
    }
  }

  // If RAG is disabled, use the original flow
  if (!ragConfig?.enabled) {
    logger(debug, "📚 RAG is disabled, using standard flow");

    if (isHitlEnabled) {
      // Graph with human-in-the-loop confirmation (no RAG)
      const agent = new StateGraph(MessagesState)
        .addNode("llmCall", llmCall)
        .addNode("toolNode", toolNode)
        .addNode("awaitConfirmation", awaitConfirmationNode)
        .addNode("trimMessages", trimMessagesNode)
        .addEdge(START, "trimMessages")
        .addEdge("trimMessages", "llmCall")
        .addConditionalEdges("llmCall", shouldContinue, [
          "toolNode",
          "awaitConfirmation",
          "trimMessages",
          END,
        ])
        .addConditionalEdges(
          "toolNode",
          (state) => {
            if (state.awaitingConfirmation) {
              return "awaitConfirmation";
            }
            return "trimMessages";
          },
          ["awaitConfirmation", "trimMessages"]
        )
        .addEdge("awaitConfirmation", "toolNode")
        .compile({
          checkpointer: memory,
          interruptBefore: ["awaitConfirmation"],
        });

      return agent;
    } else {
      // Standard flow without confirmation or RAG
      const agent = new StateGraph(MessagesState)
        .addNode("llmCall", llmCall)
        .addNode("toolNode", toolNode)
        .addNode("trimMessages", trimMessagesNode)
        .addEdge(START, "trimMessages")
        .addEdge("trimMessages", "llmCall")
        .addConditionalEdges("llmCall", shouldContinue, ["toolNode", "trimMessages", END])
        .addEdge("toolNode", "trimMessages")
        .compile({ checkpointer: memory });

      return agent;
    }
  }

  // RAG-enabled flow
  logger(debug, "📚 RAG is enabled, using RAG-enhanced flow");

  if (isHitlEnabled) {
    // Graph with RAG and human-in-the-loop confirmation
    const agent = new StateGraph(MessagesState)
      .addNode("ragRouter", ragRouter)
      .addNode("ragRetrieve", ragRetrieve)
      .addNode("llmCall", llmCall)
      .addNode("toolNode", toolNode)
      .addNode("awaitConfirmation", awaitConfirmationNode)
        .addNode("trimMessages", trimMessagesNode)
        .addEdge(START, "trimMessages")
        .addEdge("trimMessages", "ragRouter")
        .addConditionalEdges("ragRouter", ragRouterDecision, ["ragRetrieve", "llmCall"])
        .addEdge("ragRetrieve", "llmCall")
        .addConditionalEdges("llmCall", shouldContinue, [
          "toolNode",
          "awaitConfirmation",
          "trimMessages",
          END,
        ])
      .addConditionalEdges(
        "toolNode",
        (state) => {
          if (state.awaitingConfirmation) {
            return "awaitConfirmation";
          }
          return "trimMessages";
        },
        ["awaitConfirmation", "trimMessages"]
      )
      .addEdge("awaitConfirmation", "toolNode")
      .compile({
        checkpointer: memory,
        interruptBefore: ["awaitConfirmation"],
      });

    return agent;
  } else {
    // RAG-enabled flow without confirmation
    const agent = new StateGraph(MessagesState)
      .addNode("ragRouter", ragRouter)
      .addNode("ragRetrieve", ragRetrieve)
      .addNode("llmCall", llmCall)
      .addNode("toolNode", toolNode)
      .addNode("trimMessages", trimMessagesNode)
      .addEdge(START, "trimMessages")
      .addEdge("trimMessages", "ragRouter")
      .addConditionalEdges("ragRouter", ragRouterDecision, ["ragRetrieve", "llmCall"])
      .addEdge("ragRetrieve", "llmCall")
      .addConditionalEdges("llmCall", shouldContinue, ["toolNode", "trimMessages", END])
      .addEdge("toolNode", "trimMessages")
      .compile({ checkpointer: memory });

    return agent;
  }
};

export default getAgent;
