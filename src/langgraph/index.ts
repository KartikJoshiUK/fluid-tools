// Step 1: Define tools and model

import { HumanMessage } from "@langchain/core/messages";
import { createProvider } from './factory';
import getAgent from './nodes';
import {
  PendingToolCall,
  ProviderConfig,
  StreamEvent,
  ToolConfirmationConfig,
} from './types';
import { RAGConfig, RAGProvider } from '../types/rag.types';
import { DEFAULT_SYSTEM_INSTRUCTIONS } from './constants';
import { Tools } from './tool';
import { MemorySaver, StateSnapshot, Command } from "@langchain/langgraph";
import { BaseCheckpointSaver } from "@langchain/langgraph-checkpoint";
import MessagesState from "./state";

type FluidState = typeof MessagesState.State;

type ContentFilterOutput = (toolName: string, response: string) => string | Promise<string>;

class FluidTools {
  private model;
  private agent;
  private maxToolCalls: number;
  private memory: BaseCheckpointSaver;
  private tools: Tools;
  private threadTools: Map<string, Tools>;
  private threadAuthTokens: Map<string, string>;
  private maxMessages: number;

  constructor(
    {
      config,
      tools,
      getSystemInstructions = () => DEFAULT_SYSTEM_INSTRUCTIONS,
      maxToolCalls = 10,
      debug = false,
      confirmationConfig,
      ragConfig,
      ragProvider,
      contentFilterOutput,
      checkpointer,
      maxMessages = 50,
    }: {
      config: ProviderConfig,
      tools: Tools,
      getSystemInstructions: () => string,
      maxToolCalls: number,
      debug: boolean,
      contentFilterOutput?: ContentFilterOutput,
      confirmationConfig?: ToolConfirmationConfig,
      ragConfig?: RAGConfig,
      ragProvider?: RAGProvider,
      checkpointer?: BaseCheckpointSaver,
      maxMessages?: number,
    }
  ) {
    this.model = createProvider(config);
    this.tools = tools;
    this.threadTools = new Map();
    this.threadAuthTokens = new Map();
    this.memory = checkpointer ?? new MemorySaver();
    this.agent = getAgent(
      this.model,
      tools,
      this.memory,
      getSystemInstructions,
      debug,
      contentFilterOutput,
      (threadId: string) => this.threadAuthTokens.get(threadId),
      confirmationConfig,
      ragConfig,
      ragProvider
    );
    this.maxToolCalls = maxToolCalls;
    this.maxMessages = maxMessages;
  }

  public async query(
    query: string,
    threadId: string = "1",
    tools?: Tools,
    accessToken?: string
  ): Promise<FluidState> {
    this.setThreadAuthToken(threadId, accessToken);
    const config = {
      configurable: {
        thread_id: threadId,
        tools: tools ?? this.tools,
      },
    };

    // Invoke with the new message - LangGraph will automatically merge with existing state
    const result = await this.agent.invoke(
      {
        messages: [new HumanMessage(query)],
        maxToolCalls: this.maxToolCalls,
        maxMessages: this.maxMessages,
      },
      config
    );

    return result;
  }

  public async *streamQuery(
    query: string,
    threadId: string = "1",
    accessToken?: string
  ): AsyncGenerator<StreamEvent> {
    this.setThreadAuthToken(threadId, accessToken);
    const config = {
      configurable: {
        thread_id: threadId,
        tools: this.threadTools.get(threadId) ?? this.tools,
      },
    };
    const stream = await this.agent.streamEvents(
      { 
        messages: [new HumanMessage(query)], 
        maxToolCalls: this.maxToolCalls,
        maxMessages: this.maxMessages,
      },
      { ...config, version: "v2" }
    );

    for await (const event of stream) {
      yield event as StreamEvent;
    }
  }

  /**
   * Get the current conversation state from the checkpointer
   * @returns The current state including all messages
   */
  public async getConversationState(threadId: string = "1"): Promise<StateSnapshot> {
    const config = { configurable: { thread_id: threadId } };
    const state = await this.agent.getState(config);
    return state;
  }

  /**
   * Get any pending tool calls that need confirmation
   * @returns Array of pending tool calls awaiting approval (only status='pending')
   */
  public async getPendingConfirmations(
    threadId: string = "1"
  ): Promise<PendingToolCall[]> {
    const state = await this.getConversationState(threadId);
    const values = state.values as FluidState;
    const allPending = values.pendingConfirmations || [];
    // Only return those that are still pending (not approved/rejected)
    return allPending.filter((p: PendingToolCall) => p.status === "pending");
  }

  /**
   * Approve a pending tool call and continue execution
   * @param toolCallId The ID of the tool call to approve
   * @param threadId The thread ID (default: "1")
   */
  public async approveToolCall(
    toolCallId: string,
    threadId: string = "1",
    accessToken?: string
  ): Promise<FluidState> {
    const updated = await this.updateConfirmationStatus(toolCallId, threadId, "approved");
    this.setThreadAuthToken(threadId, accessToken);
    const config = {
      configurable: {
        thread_id: threadId,
        tools: this.threadTools.get(threadId) ?? this.tools,
      },
    };
    const result = await this.agent.invoke(
      new Command({
        update: {
          pendingConfirmations: updated,
          awaitingConfirmation: updated.some((p) => p.status === "pending"),
        }
      }),
      config
    );

    return result;
  }

  /**
   * Reject a pending tool call and continue execution
   * @param toolCallId The ID of the tool call to reject
   * @param threadId The thread ID (default: "1")
   */
  public async rejectToolCall(
    toolCallId: string,
    threadId: string = "1",
    accessToken?: string
  ): Promise<FluidState> {
    const updated = await this.updateConfirmationStatus(toolCallId, threadId, "rejected");
    this.setThreadAuthToken(threadId, accessToken);
    const config = {
      configurable: {
        thread_id: threadId,
        tools: this.threadTools.get(threadId) ?? this.tools,
      },
    };
    const result = await this.agent.invoke(
      new Command({
        update: {
          pendingConfirmations: updated,
          awaitingConfirmation: updated.some((p) => p.status === "pending"),
        }
      }),
      config
    );

    return result;
  }

  public async clearThreadMemory(threadId: string) {
    if ("deleteThread" in this.memory && typeof this.memory.deleteThread === "function") {
      await this.memory.deleteThread(threadId);
    }
  }

  public setThreadTools(threadId: string, tools: Tools): void {
    this.threadTools.set(threadId, tools);
  }

  public clearThreadTools(threadId: string): void {
    this.threadTools.delete(threadId);
    this.threadAuthTokens.delete(threadId);
  }

  public async *streamApproveToolCall(
    toolCallId: string,
    threadId: string = "1",
    accessToken?: string
  ): AsyncGenerator<StreamEvent> {
    const updated = await this.updateConfirmationStatus(toolCallId, threadId, "approved");
    this.setThreadAuthToken(threadId, accessToken);
    const config = {
      configurable: {
        thread_id: threadId,
        tools: this.threadTools.get(threadId) ?? this.tools,
      },
    };
    const stream = await this.agent.streamEvents(
      new Command({
        update: {
          pendingConfirmations: updated,
          awaitingConfirmation: updated.some((p) => p.status === "pending"),
        }
      }),
      { ...config, version: "v2" }
    );
    for await (const event of stream) {
      yield event as StreamEvent;
    }
  }

  public async *streamRejectToolCall(
    toolCallId: string,
    threadId: string = "1",
    accessToken?: string
  ): AsyncGenerator<StreamEvent> {
    const updated = await this.updateConfirmationStatus(toolCallId, threadId, "rejected");
    this.setThreadAuthToken(threadId, accessToken);
    const config = {
      configurable: {
        thread_id: threadId,
        tools: this.threadTools.get(threadId) ?? this.tools,
      },
    };
    const stream = await this.agent.streamEvents(
      new Command({
        update: {
          pendingConfirmations: updated,
          awaitingConfirmation: updated.some((p) => p.status === "pending"),
        }
      }),
      { ...config, version: "v2" }
    );
    for await (const event of stream) {
      yield event as StreamEvent;
    }
  }

  private async updateConfirmationStatus(
    toolCallId: string,
    threadId: string,
    status: "approved" | "rejected"
  ): Promise<PendingToolCall[]> {
    const state = await this.getConversationState(threadId);
    const values = state.values as FluidState;
    const pendingConfirmations: PendingToolCall[] = values.pendingConfirmations || [];
    const targetIndex = pendingConfirmations.findIndex((p) => p.toolCallId === toolCallId);
    if (targetIndex === -1) {
      throw new Error(`No pending confirmation found for tool call ID: ${toolCallId}`);
    }

    return pendingConfirmations.map((p, i) =>
      i === targetIndex ? { ...p, status } : p
    );
  }

  private setThreadAuthToken(threadId: string, accessToken?: string): void {
    if (typeof accessToken === "string" && accessToken.trim().length > 0) {
      this.threadAuthTokens.set(threadId, accessToken);
      return;
    }
    this.threadAuthTokens.delete(threadId);
  }
}

export default FluidTools;
