import { logger } from '../utils';
import {
  DEFAULT_EMBEDDING_MAX_CACHE_ENTRIES,
  DEFAULT_EMBEDDING_MIN_TOOLS,
} from "../constants/runtime.constants";

/**
 * Tool interface for embedding indexing
 */
export interface Tool {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
  category?: string;
}

/**
 * Search result from embedding service
 */
export interface SearchResult {
  name: string;
  score: number;
}

/**
 * Response from the /index endpoint
 */
interface IndexResponse {
  indexed_count: number;
  session_id: string;
}

/**
 * Response from the /search endpoint
 */
interface SearchResponse {
  tools: SearchResult[];
}

/**
 * Response from the DELETE /session/{session_id} endpoint
 */
interface DeleteResponse {
  deleted: boolean;
}

/**
 * Client for interacting with the Modal embedding service
 * Handles tool indexing, semantic search, and session management
 */
export class EmbeddingClient {
  private modalUrl: string;
  private cache: Map<string, string[]>;
  private debug: boolean;
  private readonly minToolsForEmbeddings: number;
  private readonly maxCacheEntries: number;

  /**
   * Create a new EmbeddingClient
   * @param modalUrl - Base URL of the Modal embedding service
   * @param debug - Enable debug logging
   * @param options - Embedding routing and cache limits
   */
  constructor(
    modalUrl: string,
    debug: boolean = false,
    options?: { minToolsForEmbeddings?: number; maxCacheEntries?: number }
  ) {
    this.modalUrl = modalUrl.endsWith("/") ? modalUrl.slice(0, -1) : modalUrl;
    this.cache = new Map();
    this.debug = debug;
    this.minToolsForEmbeddings =
      typeof options?.minToolsForEmbeddings === "number" && options.minToolsForEmbeddings >= 0
        ? options.minToolsForEmbeddings
        : DEFAULT_EMBEDDING_MIN_TOOLS;
    this.maxCacheEntries =
      typeof options?.maxCacheEntries === "number" && options.maxCacheEntries > 0
        ? options.maxCacheEntries
        : DEFAULT_EMBEDDING_MAX_CACHE_ENTRIES;

    logger(
      this.debug,
      "🔧 [EmbeddingClient] Initialized with URL:",
      this.modalUrl
    );
  }

  /**
   * Check if embeddings should be used based on tool count
   * Only use embeddings when there are more than 50 tools
   *
   * @param toolCount - Number of tools
   * @returns true if embeddings should be used, false otherwise
   */
  shouldUseEmbeddings(toolCount: number): boolean {
    const shouldUse = toolCount > this.minToolsForEmbeddings;
    if (!shouldUse) {
      logger(
        this.debug,
        `ℹ️ [EmbeddingClient.shouldUseEmbeddings] Tool count (${toolCount}) <= ${this.minToolsForEmbeddings}, skipping embeddings`
      );
    }
    return shouldUse;
  }

  /**
   * Index tools for a session
   * Sends tool metadata to Modal service for embedding generation and storage
   * Only indexes if tool count exceeds minimum threshold (50 tools)
   *
   * @param sessionId - Unique session identifier
   * @param tools - Array of tools to index
   * @throws Error if indexing fails
   */
  async indexTools(sessionId: string, tools: Tool[]): Promise<void> {
    logger(
      this.debug,
      `📊 [EmbeddingClient.indexTools] Indexing ${tools.length} tools for session ${sessionId}`
    );

    // Skip indexing if tool count is below threshold
    if (!this.shouldUseEmbeddings(tools.length)) {
      logger(
        this.debug,
        `⏭️ [EmbeddingClient.indexTools] Skipping indexing - tool count (${tools.length}) below threshold (${this.minToolsForEmbeddings})`
      );
      return;
    }

    try {
      const response = await fetch(`${this.modalUrl}/index`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          tools,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        const error = new Error(
          `Failed to index tools: ${response.status} ${response.statusText} - ${errorText}`
        );
        // Log the fallback event for monitoring (Requirement 5.4)
        logger(
          true, // Always log errors
          `❌ [EmbeddingClient.indexTools] Modal service returned error:`,
          error.message
        );
        throw error;
      }

      const data = (await response.json()) as IndexResponse;
      logger(
        this.debug,
        `✅ [EmbeddingClient.indexTools] Successfully indexed ${data.indexed_count} tools`
      );
    } catch (error) {
      // Log the fallback event for monitoring (Requirement 5.4)
      if (error instanceof TypeError && error.message.includes("fetch")) {
        logger(
          true, // Always log errors
          `❌ [EmbeddingClient.indexTools] Modal service unreachable (network error):`,
          error
        );
      } else {
        logger(
          true, // Always log errors
          `❌ [EmbeddingClient.indexTools] Error indexing tools:`,
          error
        );
      }
      throw error;
    }
  }

  /**
   * Select relevant tools for a query using semantic search
   * Results are cached to avoid redundant API calls
   *
   * @param sessionId - Unique session identifier
   * @param query - User query text
   * @param topK - Number of tools to return (default: 15)
   * @returns Array of selected tool names, or empty array on failure (triggers fallback)
   */
  async selectTools(
    sessionId: string,
    query: string,
    topK: number = 15
  ): Promise<string[]> {
    logger(
      this.debug,
      `🔍 [EmbeddingClient.selectTools] Searching for top ${topK} tools for query: "${query}"`
    );

    // Check cache (include topK in key to avoid returning wrong results)
    const cacheKey = `${sessionId}:${query}:${topK}`;
    if (this.cache.has(cacheKey)) {
      logger(
        this.debug,
        `💾 [EmbeddingClient.selectTools] Cache hit for query: "${query}" (topK: ${topK})`
      );
      return this.cache.get(cacheKey)!;
    }

    try {
      const response = await fetch(`${this.modalUrl}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          query,
          top_k: topK,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        const error = new Error(
          `Search failed: ${response.status} ${response.statusText} - ${errorText}`
        );
        // Log the fallback event for monitoring (Requirement 5.4)
        logger(
          true, // Always log errors
          `❌ [EmbeddingClient.selectTools] Modal service returned error, triggering fallback:`,
          error.message
        );
        return this.fallbackSelection();
      }

      const data = (await response.json()) as SearchResponse;
      const toolNames = data.tools.map((t) => t.name);

      logger(
        this.debug,
        `✅ [EmbeddingClient.selectTools] Selected ${toolNames.length} tools:`,
        toolNames
      );

      if (this.debug && data.tools.length > 0) {
        logger(
          this.debug,
          `📈 [EmbeddingClient.selectTools] Top 5 scores:`,
          data.tools.slice(0, 5).map((t) => `${t.name}: ${t.score.toFixed(3)}`)
        );
      }

      // Cache result with bounded FIFO eviction to avoid unbounded growth.
      this.setCacheEntry(cacheKey, toolNames);

      return toolNames;
    } catch (error) {
      // Log the fallback event for monitoring (Requirement 5.4)
      if (error instanceof TypeError && error.message.includes("fetch")) {
        logger(
          true, // Always log errors
          `❌ [EmbeddingClient.selectTools] Modal service unreachable (network error), triggering fallback:`,
          error
        );
      } else {
        logger(
          true, // Always log errors
          `❌ [EmbeddingClient.selectTools] Embedding search failed, triggering fallback:`,
          error
        );
      }
      return this.fallbackSelection();
    }
  }

  /**
   * Delete session data from the embedding service
   * Also clears local cache entries for the session
   *
   * @param sessionId - Unique session identifier
   */
  async deleteSession(sessionId: string): Promise<void> {
    logger(
      this.debug,
      `🗑️ [EmbeddingClient.deleteSession] Deleting session ${sessionId}`
    );

    try {
      const response = await fetch(`${this.modalUrl}/session/${sessionId}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Failed to delete session: ${response.status} ${response.statusText} - ${errorText}`
        );
      }

      const data = (await response.json()) as DeleteResponse;

      if (data.deleted) {
        logger(
          this.debug,
          `✅ [EmbeddingClient.deleteSession] Successfully deleted session ${sessionId}`
        );
      }

      // Clear cache for this session
      const keysToDelete: string[] = [];
      this.cache.forEach((_, key) => {
        if (key.startsWith(`${sessionId}:`)) {
          keysToDelete.push(key);
        }
      });

      keysToDelete.forEach((key) => this.cache.delete(key));

      if (keysToDelete.length > 0) {
        logger(
          this.debug,
          `🧹 [EmbeddingClient.deleteSession] Cleared ${keysToDelete.length} cache entries`
        );
      }
    } catch (error) {
      logger(
        true, // Always log errors
        `❌ [EmbeddingClient.deleteSession] Error deleting session:`,
        error
      );
      // Don't throw - session cleanup is best-effort
    }
  }

  /**
   * Fallback selection when embedding search fails
   * Returns empty array to signal backend to use all tools
   * Implements Requirement 5.1: Fall back when Embedding Service is unreachable
   *
   * @returns Empty array (triggers backend to use all tools as fallback)
   */
  private fallbackSelection(): string[] {
    logger(
      true, // Always log fallback events for monitoring (Requirement 5.4)
      `⚠️ [EmbeddingClient.fallbackSelection] Fallback triggered - returning empty array (backend will use all tools)`
    );
    return [];
  }

  /**
   * Clear all cached results
   * Useful for testing or when tool definitions change
   */
  clearCache(): void {
    const size = this.cache.size;
    this.cache.clear();
    logger(
      this.debug,
      `🧹 [EmbeddingClient.clearCache] Cleared ${size} cache entries`
    );
  }

  /**
   * Get cache statistics
   * @returns Object with cache size and keys
   */
  getCacheStats(): { size: number; keys: string[] } {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys()),
    };
  }

  private setCacheEntry(cacheKey: string, toolNames: string[]): void {
    if (this.cache.has(cacheKey)) {
      this.cache.delete(cacheKey);
    } else if (this.cache.size >= this.maxCacheEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (typeof oldestKey === "string") {
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(cacheKey, toolNames);
  }
}
