// Provider type definitions

import type { AIMessage } from "langchain";

export type ProviderType =
  | "ollama"
  | "openai"
  | "azure-openai"
  | "openai-compatible"
  | "anthropic"
  | "gemini";

export interface BaseProviderConfig {
  type: ProviderType;
  model: string;
}

export interface OllamaConfig extends BaseProviderConfig {
  type: "ollama";
  baseUrl?: string;
  temperature?: number;
  numCtx?: number;
}

export interface OpenAIConfig extends BaseProviderConfig {
  type: "openai";
  apiKey: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
}

export interface AzureOpenAIConfig extends BaseProviderConfig {
  type: "azure-openai";
  apiKey: string;
  azureOpenAIApiDeploymentName: string;
  azureOpenAIApiInstanceName: string;
  azureOpenAIApiVersion: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
}

export interface AnthropicConfig extends BaseProviderConfig {
  type: "anthropic";
  apiKey: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
}

export interface GeminiConfig extends BaseProviderConfig {
  type: "gemini";
  apiKey: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
}

export interface OpenAICompatibleConfig extends BaseProviderConfig {
  type: "openai-compatible";
  apiKey: string;
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
}

export type ProviderConfig =
  | OllamaConfig
  | OpenAIConfig
  | AzureOpenAIConfig
  | OpenAICompatibleConfig
  | AnthropicConfig
  | GeminiConfig;

/**
 * Minimal model interface used internally by FluidTools.
 *
 * Deliberately avoids referencing concrete provider classes (ChatOllama, ChatOpenAI, etc.)
 * so that those packages can truly remain optional peer dependencies for consumers.
 *
 * We still keep this fully typed by:
 * - requiring that any model returns an `AIMessage`
 * - leaving the input and tools parameters as `unknown` (safe, but not `any`)
 */
export interface Model {
  invoke(input: unknown): Promise<AIMessage>;
  bindTools(tools: unknown[]): {
    invoke(input: unknown): Promise<AIMessage>;
  };
}

export type ConfirmationMode = "manual" | "restrictive" | "none";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD" | "TRACE" | "CONNECT" | "ALL";

/**
 * Human-in-the-loop (HITL) configuration.
 */
export interface ToolConfirmationConfig {
  /**
   * Configuration mode:
   * - "manual": (Default) Only tools listed in `requireConfirmation` require approval.
   * - "restrictive": All tools require approval, except those filtered out.
   * - "none": HITL is disabled entirely.
   */
  mode?: ConfirmationMode;

  /**
   * HTTP methods that require confirmation when mode is "restrictive".
   * E.g. ["POST", "PUT", "DELETE"].
   * If ["ALL"] is included, all methods require confirmation.
   * Default: ["POST", "PUT", "PATCH", "DELETE"] if mode is "restrictive".
   */
  requireMethods?: HttpMethod[];

  /**
   * Tools that ALWAYS require human confirmation regardless of mode.
   */
  requireConfirmation?: string[];

  /**
   * Tools that NEVER require human confirmation regardless of mode or method.
   */
  excludeTools?: string[];
}

export interface PendingToolCall {
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
  status: 'pending' | 'approved' | 'rejected';
}

export type FluidErrorCode =
  | "TOOL_FAILURE"
  | "LLM_ERROR"
  | "SESSION_ERROR"
  | "CONTENT_FILTER_BLOCKED"
  | "MAX_TOOL_CALLS_EXCEEDED"
  | "RATE_LIMITED"
  | "UNKNOWN";

export interface FluidQueryError {
  code: FluidErrorCode;
  message: string;
  toolName?: string;
  retryable?: boolean;
}

export type FluidQueryResult =
  | { status: "success"; answer: string }
  | { status: "error"; error: FluidQueryError }
  | { status: "awaiting_confirmation"; pendingConfirmations: PendingToolCall[] };

export type StreamEventType =
  | "token"
  | "tool_start"
  | "tool_end"
  | "done"
  | "error"
  | "confirmation_required"
  | "confirmation_resolved";

export interface FluidStreamEvent {
  type: StreamEventType;
  data: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  pendingConfirmations?: PendingToolCall[];
}

export interface StreamEvent {
  event?: string;
  name?: string;
  data?: {
    chunk?: {
      content?: unknown;
    };
    input?: Record<string, unknown>;
  };
}
