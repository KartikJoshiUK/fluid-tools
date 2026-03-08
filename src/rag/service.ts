import { logger } from '../utils';
import type {
  RAGConfig,
  RAGDocument,
  RAGEnhancementResult,
  RAGProvider,
  RAGSearchOptions,
} from '../types/rag.types';
import { RAG_DEFAULTS, RAG_MESSAGES } from '../constants/rag.constants';

/**
 * RAG Service - Handles Retrieval Augmented Generation
 * 
 * This service provides a clean interface for RAG operations while remaining
 * completely framework-agnostic. It can work with any RAG provider implementation.
 */
export class RAGService {
  private provider?: RAGProvider;
  private config: RAGConfig;
  private debug: boolean;

  constructor(provider?: RAGProvider, config?: Partial<RAGConfig>, debug: boolean = false) {
    this.provider = provider;
    this.debug = debug;
    this.config = {
      enabled: !!provider,
      maxDocuments: RAG_DEFAULTS.MAX_DOCUMENTS,
      similarityThreshold: RAG_DEFAULTS.SIMILARITY_THRESHOLD,
      contextWindow: RAG_DEFAULTS.CONTEXT_WINDOW,
      ...config,
    };

    this.logDebug("Initialized", {
      enabled: this.config.enabled,
      hasProvider: !!this.provider,
      maxDocuments: this.config.maxDocuments,
      threshold: this.config.similarityThreshold,
      ragRoutingHints: this.config.ragRoutingHints
    });
  }

  /**
   * Check if RAG is enabled and available
   */
  async isEnabled(): Promise<boolean> {
    if (!this.config.enabled || !this.provider) {
      return false;
    }

    try {
      return await this.provider.isAvailable();
    } catch (error) {
      this.logDebug("Provider availability check failed:", error);
      return false;
    }
  }

  /**
   * Enhance a query with relevant context from RAG
   * 
   * @param query - Original user query
   * @returns Enhanced query with context or original query if RAG unavailable
   */
  async enhanceQuery(query: string): Promise<string> {
    const result = await this.enhanceQueryWithMetadata(query);
    return result.enhancedQuery;
  }

  /**
   * Enhance a query with relevant context and return detailed metadata
   * 
   * @param query - Original user query
   * @returns Enhancement result with metadata
   */
  async enhanceQueryWithMetadata(query: string): Promise<RAGEnhancementResult> {
    const baseResult: RAGEnhancementResult = {
      enhancedQuery: query,
      originalQuery: query,
      wasEnhanced: false,
      documentsUsed: 0,
      contextLength: 0,
      documentsFound: [],
    };

    if (!await this.isEnabled()) {
      this.logDebug("RAG not available, returning original query");
      return baseResult;
    }

    try {
      const searchOptions: RAGSearchOptions = {
        limit: this.config.maxDocuments,
        threshold: this.config.similarityThreshold,
      };

      const relevantDocs = await this.provider!.searchSimilarDocuments(query, searchOptions);

      if (relevantDocs.length === 0) {
        this.logDebug("No relevant documents found");
        return baseResult;
      }

      this.logDebug(`Found ${relevantDocs.length} relevant documents`, 
        relevantDocs.map(doc => ({ 
          id: doc.id, 
          score: doc.score, 
          contentPreview: doc.content.substring(0, 100) + '...' 
        }))
      );

      const context = this.buildContext(relevantDocs);
      const enhancedQuery = this.combineQueryWithContext(query, context);

      const result: RAGEnhancementResult = {
        enhancedQuery,
        originalQuery: query,
        wasEnhanced: true,
        documentsUsed: relevantDocs.length,
        contextLength: context.length,
        documentsFound: relevantDocs,
      };

      this.logDebug(`Enhanced query - Documents: ${result.documentsUsed}, Context: ${result.contextLength} chars`);
      return result;

    } catch (error) {
      this.logError("Error enhancing query, falling back to original:", error);
      return baseResult;
    }
  }

  /**
   * Index documents for future retrieval
   * 
   * @param documents - Documents to index
   */
  async indexDocuments(documents: RAGDocument[]): Promise<void> {
    if (!await this.isEnabled()) {
      this.logDebug("RAG not available, skipping indexing");
      return;
    }

    try {
      await this.provider!.indexDocuments(documents);
      this.logDebug(`Successfully indexed ${documents.length} documents`);
    } catch (error) {
      this.logError("Error indexing documents:", error);
      throw error;
    }
  }

  /**
   * Update RAG configuration
   * 
   * @param newConfig - New configuration options
   */
  updateConfig(newConfig: Partial<RAGConfig>): void {
    this.config = { ...this.config, ...newConfig };
    this.logDebug("Configuration updated:", this.config);
  }

  /**
   * Get current RAG configuration
   */
  getConfig(): RAGConfig {
    return { ...this.config };
  }

  /**
   * Build context string from relevant documents
   */
  private buildContext(documents: RAGDocument[]): string {
    const contextParts: string[] = [];
    let totalLength = 0;

    for (const doc of documents) {
      const docContext = `[Document ${doc.id}]: ${doc.content}`;
      
      if (totalLength + docContext.length > this.config.contextWindow!) {
        break;
      }

      contextParts.push(docContext);
      totalLength += docContext.length;
    }

    return contextParts.join('\n\n');
  }

  /**
   * Combine original query with retrieved context
   */
  private combineQueryWithContext(query: string, context: string): string {
    if (!context.trim()) {
      return query;
    }

    return RAG_MESSAGES.CONTEXT_TEMPLATE
      .replace('{context}', context)
      .replace('{query}', query);
  }

  /**
   * Log debug messages with consistent formatting
   */
  private logDebug(message: string, data?: unknown): void {
    logger(this.debug, `✅ [RAGService] ${message}`, data);
  }

  /**
   * Log error messages with consistent formatting
   */
  private logError(message: string, error?: unknown): void {
    logger(true, `❌ [RAGService] ${message}`, error);
  }
}