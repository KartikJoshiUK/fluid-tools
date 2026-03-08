import axios from "axios";
import FluidTools from '../langgraph/index.js';
import { DEFAULT_SYSTEM_INSTRUCTIONS } from '../langgraph/constants.js';
import FluidSession from '../langgraph/session.js';
import { Tools } from '../langgraph/tool.js';
import {
  FluidErrorCode,
  FluidQueryResult,
  FluidStreamEvent,
  ProviderConfig,
  ToolConfirmationConfig,
} from '../langgraph/types.js';
import { logger } from '../utils/index.js';
import { postmanToTools } from '../converters/postman-to-tools.js';
import type { PostmanCollection } from '../converters/types.js';
import type { OpenAPISpec } from "../converters/openapi.types.js";
import { openApiToTools } from "../converters/openapi-to-tools.js";
import type { RetryConfig } from "../converters/retry.types.js";
import { EmbeddingClient, Tool } from '../embeddings/client.js';
import { RAGConfig, RAGDocument, RAGProvider } from '../types/rag.types.js';
import { QueryConfig, QueryLog, QueryMetadata, QueryProvider } from '../types/query.types.js';
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import { HeaderResolver } from "../types/header.types.js";
import type { ContentFilter } from "../types/filter.types.js";
import type { RateLimitConfig } from "../types/ratelimit.types.js";
import { DEFAULT_EMBEDDING_TOP_K } from "../constants/runtime.constants.js";

/**
 * Configuration for embedding-based tool selection
 */
export interface EmbeddingConfig {
  enabled: boolean;
  modalUrl: string;
  sessionId?: string;
  minToolsForEmbeddings?: number;
  maxCacheEntries?: number;
  topK?: number;
}

export interface SessionConfig {
  /**
   * Interval for cleaning expired in-memory sessions.
   * Lower values clean up faster but use more CPU.
   */
  cleanupIntervalMs?: number;
}

export interface ToolExecutionConfig {
  /**
   * Default request timeout applied to generated tools.
   */
  requestTimeoutMs?: number;
  /**
   * Maximum serialized tool response bytes kept in model context.
   */
  maxToolResponseBytes?: number;
}

interface BaseFluidToolsClientOptions {
  config: ProviderConfig;
  systemInstructions?: string;
  maxToolCalls?: number;
  debug?: boolean;
  expireAfterSeconds?: number;
  confirmationConfig?: ToolConfirmationConfig;
  toolsConfig?: Record<string, string>;
  toolExecutionConfig?: ToolExecutionConfig;
  embeddingConfig?: EmbeddingConfig;
  sessionConfig?: SessionConfig;
  ragProvider?: RAGProvider;
  ragConfig?: Partial<RAGConfig>;
  queryProvider?: QueryProvider;
  queryConfig?: Partial<QueryConfig>;
  /**
   * WARNING: durable checkpointers can persist graph runtime config/state.
   * Do not pass raw long-lived secrets as access tokens without applying your own secret-handling policy.
   */
  checkpointer?: BaseCheckpointSaver;
  headerResolver?: HeaderResolver;
  retryConfig?: RetryConfig;
  contentFilter?: ContentFilter;
  rateLimitConfig?: RateLimitConfig;
}

type PostmanSourceOptions = {
  postmanCollection: PostmanCollection;
  openApiSpec?: never;
};

type OpenApiSourceOptions = {
  openApiSpec: OpenAPISpec;
  postmanCollection?: never;
};

export type FluidToolsClientOptions = BaseFluidToolsClientOptions &
  (PostmanSourceOptions | OpenApiSourceOptions);

/**
 * FluidTools Client - Main interface for AI-powered tool execution
 * 
 * This client provides a high-level interface for:
 * - AI-powered query processing with tool execution
 * - RAG (Retrieval Augmented Generation) integration
 * - Embedding-based tool selection
 * - Session and conversation management
 */
class FluidToolsClient {
  private config: ProviderConfig;
  private systemInstructions: string;
  private maxToolCalls: number;
  private fluidTool: FluidTools;
  private debug: boolean;
  private tools: Tools;
  private confirmationConfig?: ToolConfirmationConfig;
  private sessionMap: FluidSession;
  private embeddingClient?: EmbeddingClient;
  private enableEmbeddings: boolean;
  private embeddingSessionId?: string;
  private embeddingTopK: number;
  private ragProvider?: RAGProvider;
  private ragConfig?: RAGConfig;
  private queryProvider?: QueryProvider;
  private queryConfig?: QueryConfig;
  private headerResolver: HeaderResolver;
  private contentFilterInput: (query: string) => string | Promise<string>;
  private contentFilterOutput: (toolName: string, response: string) => string | Promise<string>;
  private rateLimitConfig?: RateLimitConfig;

  constructor(
    options: FluidToolsClientOptions
  ) {
    const defaultHeaderResolver: HeaderResolver = (
      _toolName: string,
      token: string | undefined
    ) => {
      const headers: Record<string, string> = {};
      if (token && token.length > 0) {
        headers.Authorization = `Bearer ${token}`;
      }
      return headers;
    };
    this.headerResolver = options.headerResolver ?? defaultHeaderResolver;
    this.contentFilterInput = options.contentFilter?.input ?? (async (query) => query);
    this.contentFilterOutput = options.contentFilter?.output ?? (async (_toolName, response) => response);
    this.rateLimitConfig = options.rateLimitConfig;
    const resolvedToolsConfig: Record<string, string> = { ...(options.toolsConfig ?? {}) };
    if (typeof options.toolExecutionConfig?.requestTimeoutMs === "number" && options.toolExecutionConfig.requestTimeoutMs > 0) {
      resolvedToolsConfig.REQUEST_TIMEOUT_MS = String(options.toolExecutionConfig.requestTimeoutMs);
    }
    if (
      typeof options.toolExecutionConfig?.maxToolResponseBytes === "number" &&
      options.toolExecutionConfig.maxToolResponseBytes > 0
    ) {
      resolvedToolsConfig.MAX_TOOL_RESPONSE_BYTES = String(options.toolExecutionConfig.maxToolResponseBytes);
    }

    const builtTools = options.postmanCollection
      ? postmanToTools(
          options.postmanCollection,
          axios,
          resolvedToolsConfig,
          options.retryConfig,
          this.headerResolver,
          options.debug ?? false
        )
      : openApiToTools(
          options.openApiSpec,
          axios,
          resolvedToolsConfig,
          options.retryConfig,
          this.headerResolver,
          options.debug ?? false
        );
    this.tools = new Tools(builtTools, resolvedToolsConfig);
    this.config = options.config;
    this.systemInstructions = options.systemInstructions ?? "";
    this.maxToolCalls = options.maxToolCalls ?? 10;
    this.debug = options.debug ?? false;
    this.confirmationConfig = options.confirmationConfig;

    // Store RAG provider and config to pass to FluidTools
    this.ragProvider = options.ragProvider;
    this.ragConfig = options.ragConfig ? {
      enabled: !!options.ragProvider,
      maxDocuments: options.ragConfig.maxDocuments || 5,
      similarityThreshold: options.ragConfig.similarityThreshold || 0.7,
      contextWindow: options.ragConfig.contextWindow || 4000,
      ragRoutingHints: options.ragConfig.ragRoutingHints,
    } : undefined;

    // Store Query provider and config
    this.queryProvider = options.queryProvider;
    this.queryConfig = options.queryConfig ? {
      enabled: !!options.queryProvider,
      includeMetadata: options.queryConfig.includeMetadata ?? true,
    } : undefined;

    // Initialize embedding client if enabled
    this.enableEmbeddings = options.embeddingConfig?.enabled ?? false;
    this.embeddingSessionId = options.embeddingConfig?.sessionId;
    this.embeddingTopK = options.embeddingConfig?.topK ?? DEFAULT_EMBEDDING_TOP_K;
    if (this.enableEmbeddings && options.embeddingConfig?.modalUrl) {
      this.embeddingClient = new EmbeddingClient(
        options.embeddingConfig.modalUrl,
        options.debug,
        {
          minToolsForEmbeddings: options.embeddingConfig.minToolsForEmbeddings,
          maxCacheEntries: options.embeddingConfig.maxCacheEntries,
        }
      );
      logger(this.debug, "🔧 [FluidToolsClient] Embeddings enabled");
    } else {
      logger(this.debug, "ℹ️ [FluidToolsClient] Embeddings disabled");
    }

    // Log query tracking status
    if (this.queryProvider && this.queryConfig?.enabled) {
      logger(this.debug, "🔧 [FluidToolsClient] Query tracking enabled");
    } else {
      logger(this.debug, "ℹ️ [FluidToolsClient] Query tracking disabled");
    }

    this.sessionMap = new FluidSession(
      (options.expireAfterSeconds ?? 3600) * 1000,
      options.sessionConfig?.cleanupIntervalMs
    );

    this.fluidTool = new FluidTools({
      config: this.config,
      tools: this.tools,
      getSystemInstructions: this.getSystemInstructions,
      maxToolCalls: this.maxToolCalls,
      debug: this.debug,
      confirmationConfig: this.confirmationConfig,
      ragConfig: this.ragConfig,
      ragProvider: this.ragProvider,
      contentFilterOutput: this.contentFilterOutput,
      checkpointer: options.checkpointer,
    });
  }

  private getSystemInstructions = () => {
    const currentDate = new Date().toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    // Build context variables for template replacement
    const contextVars: Record<string, string> = {
      "{date}": currentDate,
      "{max_tool_calls}": this.maxToolCalls.toString(),
      "{tool_count}": Object.keys(this.tools.getToolByName()).length.toString(),
    };

    // Replace all context variables in the base prompt
    let prompt = DEFAULT_SYSTEM_INSTRUCTIONS;
    Object.entries(contextVars).forEach(([key, value]) => {
      prompt = prompt.replace(new RegExp(key, "g"), value);
    });

    // Add custom instructions if provided
    if (this.systemInstructions) {
      prompt += `\n\n<Additional Instructions>\n${this.systemInstructions}\n</Additional Instructions>`;
    }

    // Add recursion limit reminder
    prompt += `\n\n<Important Constraints>\n- You can make a maximum of ${this.maxToolCalls} tool calls per query\n- Plan your tool usage efficiently to stay within this limit\n- If you're approaching the limit, prioritize the most important information\n</Important Constraints>`;

    return prompt;
  };

  /**
   * Index tools for a session to enable embedding-based tool selection
   * 
   * @param sessionId - Unique session identifier
   * @param tools - Array of tools to index
   */
  public async indexToolsForSession(sessionId: string, tools: Tool[]): Promise<void> {
    if (!this.embeddingClient) {
      logger(this.debug, "ℹ️ [FluidToolsClient] Embedding client not initialized, skipping indexing");
      return;
    }

    try {
      logger(this.debug, `📊 [FluidToolsClient] Indexing ${tools.length} tools for session ${sessionId}`);
      await this.embeddingClient.indexTools(sessionId, tools);
      logger(this.debug, `✅ [FluidToolsClient] Successfully indexed tools for session ${sessionId}`);
    } catch (error) {
      logger(true, `❌ [FluidToolsClient] Failed to index tools for session ${sessionId}:`, error);
      logger(true, "⚠️ [FluidToolsClient] Continuing without embeddings - will use all tools as fallback");
    }
  }

  private getSessionDetails(accessToken?: string){
    return this.sessionMap.getSession(accessToken, (threadId: string)=>{
      this.fluidTool.clearThreadMemory(threadId);
      this.fluidTool.clearThreadTools(threadId);
    })
  }

  public async clearThread(accessToken?: string) {
    const threadId = this.getSessionDetails(accessToken).threadId;
    this.sessionMap.deleteSession(accessToken);
    this.fluidTool.clearThreadTools(threadId);
    if (threadId) await this.fluidTool.clearThreadMemory(threadId);
  }


  private normalizeResponseContent(response: { messages: Array<{ content: unknown }> }): FluidQueryResult {
    const content = response.messages.at(-1)?.content;
    if (typeof content === "string") {
      return { status: "success", answer: content };
    }
    if (Array.isArray(content)) {
      const answer = content
        .map((c) => (typeof c === "string" ? c : ((c as { text?: string }).text ?? "")))
        .join("");
      return { status: "success", answer };
    }
    return { status: "success", answer: "" };
  }

  private classifyError(error: unknown): { code: FluidErrorCode; message: string; retryable?: boolean } {
    const message = error instanceof Error ? error.message : "Unknown error";
    const normalized = message.toLowerCase();

    if (normalized.includes("accesstoken") || normalized.includes("session")) {
      return { code: "SESSION_ERROR", message };
    }
    if (normalized.includes("content filter") || normalized.includes("blocked")) {
      return { code: "CONTENT_FILTER_BLOCKED", message };
    }
    if (normalized.includes("tool")) {
      return { code: "TOOL_FAILURE", message, retryable: true };
    }
    if (normalized.includes("llm") || normalized.includes("model")) {
      return { code: "LLM_ERROR", message, retryable: true };
    }

    return { code: "UNKNOWN", message };
  }

  public async query(query: string, accessToken?: string, metadata?: QueryMetadata): Promise<FluidQueryResult> {
    let acquiredConcurrencySlot = false;
    try {
      const filteredQuery = await this.contentFilterInput(query);
      logger(this.debug, "\n🎯 [FluidToolsClient] Query received:", filteredQuery);

      const threadId = this.getSessionDetails(accessToken).threadId;
      const concurrencyResult = this.sessionMap.acquireConcurrencySlot(
        accessToken,
        this.rateLimitConfig
      );
      if (!concurrencyResult.allowed) {
        return {
          status: "error",
          error: {
            code: "RATE_LIMITED",
            message: `Too many concurrent queries. Try again in ${concurrencyResult.retryAfterMs ?? 0}ms.`,
            retryable: true,
          },
        };
      }
      acquiredConcurrencySlot = true;
      const rateLimitResult = this.sessionMap.checkRateLimit(accessToken, this.rateLimitConfig);
      if (!rateLimitResult.allowed) {
        return {
          status: "error",
          error: {
            code: "RATE_LIMITED",
            message: `Rate limit exceeded. Try again in ${rateLimitResult.retryAfterMs ?? 0}ms.`,
            retryable: true,
          },
        };
      }

      // Log query if query tracking is enabled
      if (this.queryProvider && this.queryConfig?.enabled && metadata?.clientId) {
        try {
          const queryLog: QueryLog = {
            clientId: metadata.clientId,
            threadId,
            query: filteredQuery,
            metadata: this.queryConfig.includeMetadata ? {
              projectId: metadata.projectId,
              region: metadata.region,
            } : undefined,
            error: false,
            created_at: new Date(),
          };

          await this.queryProvider.logQuery(queryLog);
          logger(this.debug, `✅ [FluidToolsClient] Query logged for client: ${metadata.clientId}`);
        } catch (loggingError) {
          // Log the error but don't disrupt query processing
          logger(true, `⚠️ [FluidToolsClient] Failed to log query:`, loggingError);
        }
      } else if (metadata?.clientId && !this.queryProvider) {
        logger(this.debug, "ℹ️ [FluidToolsClient] Skipping query logging - query provider not configured");
      } else if (!metadata?.clientId) {
        logger(this.debug, "ℹ️ [FluidToolsClient] Skipping query logging - clientId not provided");
      }

      const scopedTools = await this.getScopedTools(filteredQuery, threadId);
      const response = await this.fluidTool.query(
        filteredQuery,
        threadId,
        scopedTools,
        accessToken
      );
      const pendingConfirmations = await this.fluidTool.getPendingConfirmations(threadId);
      if (pendingConfirmations.length > 0) {
        return { status: "awaiting_confirmation", pendingConfirmations };
      }

      return this.normalizeResponseContent(response as { messages: Array<{ content: unknown }> });
    } catch (error: unknown) {
      const classifiedError = this.classifyError(error);
      return {
        status: "error",
        error: {
          code: classifiedError.code,
          message: classifiedError.message,
          retryable: classifiedError.retryable,
        },
      };
    } finally {
      if (acquiredConcurrencySlot) {
        this.sessionMap.releaseConcurrencySlot(accessToken);
      }
    }
  }

  private async getScopedTools(query: string, threadId: string): Promise<Tools> {
    if (this.enableEmbeddings && this.embeddingClient) {
      try {
        const lookupId = this.embeddingSessionId || threadId;
        const selectedToolNames = await this.embeddingClient.selectTools(lookupId, query, this.embeddingTopK);

        if (selectedToolNames.length > 0) {
          logger(this.debug, `✅ [FluidToolsClient] Selected ${selectedToolNames.length} tools`);
          return this.tools.withFilter(selectedToolNames);
        }

        logger(this.debug, `⚠️ [FluidToolsClient] No tools selected, using all tools`);
        return this.tools;
      } catch (error) {
        logger(true, `❌ [FluidToolsClient] Tool selection failed, falling back to all tools:`, error);
        return this.tools;
      }
    }

    logger(this.debug, "ℹ️ [FluidToolsClient] Embeddings disabled, using all tools");
    return this.tools;
  }

  public async *stream(
    query: string,
    accessToken?: string,
    metadata?: QueryMetadata
  ): AsyncGenerator<FluidStreamEvent> {
    const filteredQuery = await this.contentFilterInput(query);
    const threadId = this.getSessionDetails(accessToken).threadId;
    let acquiredConcurrencySlot = false;
    const concurrencyResult = this.sessionMap.acquireConcurrencySlot(accessToken, this.rateLimitConfig);
    if (!concurrencyResult.allowed) {
      yield {
        type: "error",
        data: `Too many concurrent queries. Try again in ${concurrencyResult.retryAfterMs ?? 0}ms.`,
      };
      yield { type: "done", data: "" };
      return;
    }
    acquiredConcurrencySlot = true;
    const rateLimitResult = this.sessionMap.checkRateLimit(accessToken, this.rateLimitConfig);
    if (!rateLimitResult.allowed) {
      this.sessionMap.releaseConcurrencySlot(accessToken);
      acquiredConcurrencySlot = false;
      yield {
        type: "error",
        data: `Rate limit exceeded. Try again in ${rateLimitResult.retryAfterMs ?? 0}ms.`,
      };
      yield { type: "done", data: "" };
      return;
    }

    // Log query if query tracking is enabled
    if (this.queryProvider && this.queryConfig?.enabled && metadata?.clientId) {
      try {
        const queryLog: QueryLog = {
          clientId: metadata.clientId,
          threadId,
          query: filteredQuery,
          metadata: this.queryConfig.includeMetadata ? {
            projectId: metadata.projectId,
            region: metadata.region,
          } : undefined,
          error: false,
          created_at: new Date(),
        };

        await this.queryProvider.logQuery(queryLog);
        logger(this.debug, `✅ [FluidToolsClient] Query logged for client: ${metadata.clientId}`);
      } catch (loggingError) {
        // Log the error but don't disrupt query processing
        logger(true, `⚠️ [FluidToolsClient] Failed to log query:`, loggingError);
      }
    } else if (metadata?.clientId && !this.queryProvider) {
      logger(this.debug, "ℹ️ [FluidToolsClient] Skipping query logging - query provider not configured");
    } else if (!metadata?.clientId) {
      logger(this.debug, "ℹ️ [FluidToolsClient] Skipping query logging - clientId not provided");
    }

    const scopedTools = await this.getScopedTools(filteredQuery, threadId);

    this.fluidTool.setThreadTools(threadId, scopedTools);
    let shouldClearThreadTools = true;
    try {
      for await (const event of this.fluidTool.streamQuery(filteredQuery, threadId, accessToken)) {
        const kind = event.event;
        if (kind === "on_chat_model_stream") {
          const chunk = event.data?.chunk;
          const text = chunk?.content;
          if (typeof text === "string" && text.length > 0) {
            yield { type: "token", data: text };
          }
        } else if (kind === "on_tool_start") {
          yield {
            type: "tool_start",
            data: event.name ?? "",
            toolName: event.name,
            toolArgs: event.data?.input,
          };
        } else if (kind === "on_tool_end") {
          yield { type: "tool_end", data: event.name ?? "", toolName: event.name };
        }
      }
      const pendingConfirmations = await this.fluidTool.getPendingConfirmations(threadId);
      if (pendingConfirmations.length > 0) {
        shouldClearThreadTools = false;
        yield {
          type: "confirmation_required",
          data: "",
          pendingConfirmations,
        };
        return;
      }
      yield { type: "done", data: "" };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown stream error";
      yield { type: "error", data: message };
      yield { type: "done", data: "" };
    } finally {
      if (shouldClearThreadTools) {
        this.fluidTool.clearThreadTools(threadId);
      }
      if (acquiredConcurrencySlot) {
        this.sessionMap.releaseConcurrencySlot(accessToken);
      }
    }
  }

  public async *streamApproveToolCall(
    toolCallId: string,
    accessToken?: string
  ): AsyncGenerator<FluidStreamEvent> {
    const threadId = this.getSessionDetails(accessToken).threadId;
    yield { type: "confirmation_resolved", data: toolCallId };
    let shouldClearThreadTools = true;
    try {
      for await (const event of this.fluidTool.streamApproveToolCall(toolCallId, threadId, accessToken)) {
        const kind = event.event;
        if (kind === "on_chat_model_stream") {
          const chunk = event.data?.chunk;
          const text = chunk?.content;
          if (typeof text === "string" && text.length > 0) {
            yield { type: "token", data: text };
          }
        } else if (kind === "on_tool_start") {
          yield {
            type: "tool_start",
            data: event.name ?? "",
            toolName: event.name,
            toolArgs: event.data?.input,
          };
        } else if (kind === "on_tool_end") {
          yield { type: "tool_end", data: event.name ?? "", toolName: event.name };
        }
      }

      const pendingConfirmations = await this.fluidTool.getPendingConfirmations(threadId);
      if (pendingConfirmations.length > 0) {
        shouldClearThreadTools = false;
        yield {
          type: "confirmation_required",
          data: "",
          pendingConfirmations,
        };
        return;
      }
      yield { type: "done", data: "" };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown stream error";
      yield { type: "error", data: message };
      yield { type: "done", data: "" };
    } finally {
      if (shouldClearThreadTools) {
        this.fluidTool.clearThreadTools(threadId);
      }
    }
  }

  public async *streamRejectToolCall(
    toolCallId: string,
    accessToken?: string
  ): AsyncGenerator<FluidStreamEvent> {
    const threadId = this.getSessionDetails(accessToken).threadId;
    yield { type: "confirmation_resolved", data: toolCallId };
    let shouldClearThreadTools = true;
    try {
      for await (const event of this.fluidTool.streamRejectToolCall(toolCallId, threadId, accessToken)) {
        const kind = event.event;
        if (kind === "on_chat_model_stream") {
          const chunk = event.data?.chunk;
          const text = chunk?.content;
          if (typeof text === "string" && text.length > 0) {
            yield { type: "token", data: text };
          }
        } else if (kind === "on_tool_start") {
          yield {
            type: "tool_start",
            data: event.name ?? "",
            toolName: event.name,
            toolArgs: event.data?.input,
          };
        } else if (kind === "on_tool_end") {
          yield { type: "tool_end", data: event.name ?? "", toolName: event.name };
        }
      }

      const pendingConfirmations = await this.fluidTool.getPendingConfirmations(threadId);
      if (pendingConfirmations.length > 0) {
        shouldClearThreadTools = false;
        yield {
          type: "confirmation_required",
          data: "",
          pendingConfirmations,
        };
        return;
      }
      yield { type: "done", data: "" };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown stream error";
      yield { type: "error", data: message };
      yield { type: "done", data: "" };
    } finally {
      if (shouldClearThreadTools) {
        this.fluidTool.clearThreadTools(threadId);
      }
    }
  }



  /**
   * Get the current conversation state
   */
  public async getConversationState(accessToken?: string) {
    const threadId = this.getSessionDetails(accessToken).threadId;
    return await this.fluidTool.getConversationState(threadId);
  }

  /**
   * Get any pending tool calls that need confirmation
   */
  public async getPendingConfirmations(accessToken?: string) {
    const threadId = this.getSessionDetails(accessToken).threadId;
    return await this.fluidTool.getPendingConfirmations(threadId);
  }

  /**
   * Approve a pending tool call and continue execution
   * @param toolCallId The ID of the tool call to approve
   */
  public async approveToolCall(toolCallId: string, accessToken?: string): Promise<FluidQueryResult> {
    try {
      const threadId = this.getSessionDetails(accessToken).threadId;
      const result = await this.fluidTool.approveToolCall(toolCallId, threadId, accessToken);
      const pendingConfirmations = await this.fluidTool.getPendingConfirmations(threadId);
      if (pendingConfirmations.length > 0) {
        return { status: "awaiting_confirmation", pendingConfirmations };
      }
      return this.normalizeResponseContent(result as { messages: Array<{ content: unknown }> });
    } catch (error: unknown) {
      const classifiedError = this.classifyError(error);
      return {
        status: "error",
        error: {
          code: classifiedError.code,
          message: classifiedError.message,
          retryable: classifiedError.retryable,
        },
      };
    }
  }

  /**
   * Reject a pending tool call and continue execution
   * @param toolCallId The ID of the tool call to reject
   */
  public async rejectToolCall(toolCallId: string, accessToken?: string): Promise<FluidQueryResult> {
    try {
      const threadId = this.getSessionDetails(accessToken).threadId;
      const result = await this.fluidTool.rejectToolCall(toolCallId, threadId, accessToken);
      const pendingConfirmations = await this.fluidTool.getPendingConfirmations(threadId);
      if (pendingConfirmations.length > 0) {
        return { status: "awaiting_confirmation", pendingConfirmations };
      }
      return this.normalizeResponseContent(result as { messages: Array<{ content: unknown }> });
    } catch (error: unknown) {
      const classifiedError = this.classifyError(error);
      return {
        status: "error",
        error: {
          code: classifiedError.code,
          message: classifiedError.message,
          retryable: classifiedError.retryable,
        },
      };
    }
  }

  /**
   * Index documents for RAG retrieval
   * @param documents Array of documents to index
   */
  public async indexDocuments(
    documents: Array<{ id: string; content: string; metadata?: Record<string, unknown> }>
  ) {
    if (!this.ragProvider) {
      logger(this.debug, "⚠️ [FluidToolsClient] No RAG provider available for indexing");
      return;
    }

    const ragDocuments: RAGDocument[] = documents.map(doc => ({
      id: doc.id,
      content: doc.content,
      metadata: doc.metadata || {}
    }));
    
    await this.ragProvider.indexDocuments(ragDocuments);
    logger(this.debug, `✅ [FluidToolsClient] Indexed ${ragDocuments.length} documents`);
  }

  /**
   * Check if RAG is enabled and available
   */
  public async isRAGEnabled(): Promise<boolean> {
    if (!this.ragConfig?.enabled || !this.ragProvider) {
      return false;
    }
    
    try {
      return await this.ragProvider.isAvailable();
    } catch (error) {
      logger(this.debug, "❌ [FluidToolsClient] RAG provider availability check failed:", error);
      return false;
    }
  }

}

export default FluidToolsClient;
