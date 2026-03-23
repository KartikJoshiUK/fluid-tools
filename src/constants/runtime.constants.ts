/**
 * Runtime defaults for FluidTools.
 *
 * Keep internal safety/housekeeping defaults here so they are easy to audit.
 * Business-facing values should be overrideable via `FluidToolsClientOptions`.
 */

/**
 * Default HTTP timeout for generated API tool calls.
 * This is business-facing and can be overridden by users.
 */
export const DEFAULT_TOOL_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Default max serialized tool response size injected into model context.
 * This is business-facing and can be overridden by users.
 */
export const DEFAULT_MAX_TOOL_RESPONSE_BYTES = 50_000;

/**
 * Default session TTL when `FluidSession` is used directly.
 * `FluidToolsClient` applies its own default via `expireAfterSeconds`.
 */
export const DEFAULT_SESSION_DURATION_MS = 10 * 60 * 1000;

/**
 * Cleanup sweep guardrails to avoid too-frequent timer work or very stale cleanup.
 * These are internal runtime safety bounds.
 */
export const MIN_SESSION_CLEANUP_INTERVAL_MS = 5_000;
export const MAX_SESSION_CLEANUP_INTERVAL_MS = 60_000;

/**
 * Default number of tools requested from embedding-based selection.
 * This is business-facing and can be overridden by users.
 */
export const DEFAULT_EMBEDDING_TOP_K = 15;

/**
 * Default threshold for enabling embedding routing by tool count.
 * This is business-facing and can be overridden by users.
 */
export const DEFAULT_EMBEDDING_MIN_TOOLS = 50;

/**
 * Default cap for in-memory embedding selection cache.
 * This is business-facing and can be overridden by users.
 */
export const DEFAULT_EMBEDDING_MAX_CACHE_ENTRIES = 1_000;
