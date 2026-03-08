/**
 * RAG (Retrieval Augmented Generation) Type Definitions
 * 
 * This file contains all type definitions for the RAG system.
 * These types are framework-agnostic and can be used across different implementations.
 */

/**
 * Represents a document in the RAG system
 */
export interface RAGDocument {
  /** Unique identifier for the document */
  id: string;
  
  /** Text content of the document */
  content: string;
  
  /** Optional metadata associated with the document */
  metadata?: Record<string, unknown>;
  
  /** Optional vector embedding for similarity search */
  embedding?: number[];
  
  /** Similarity score when returned from search (0-1, higher is more similar) */
  score?: number;
}

/**
 * Configuration options for RAG search operations
 */
export interface RAGSearchOptions {
  /** Maximum number of documents to return */
  limit?: number;
  
  /** Minimum similarity threshold (0-1) */
  threshold?: number;
  
  /** Additional filters to apply during search */
  filters?: Record<string, unknown>;
}

/**
 * Configuration for the RAG system
 */
export interface RAGConfig {
  /** Whether RAG is enabled */
  enabled: boolean;
  
  /** Maximum number of documents to retrieve for context */
  maxDocuments?: number;
  
  /** Minimum similarity threshold for document inclusion */
  similarityThreshold?: number;
  
  /** Maximum context window size in characters */
  contextWindow?: number;
  
  /** Optional routing hints for ragRouter to guide when to use RAG */
  ragRoutingHints?: string[];
}

/**
 * Decision result from RAG router node
 */
export interface RAGDecision {
  /** Whether to use RAG for this query */
  useRag: boolean;
  
  /** Query to use for retrieval (may be different from user input) */
  query?: string;
  
  /** Number of documents to retrieve */
  k?: number;
}

/**
 * Result of RAG query enhancement with metadata
 */
export interface RAGEnhancementResult {
  /** The enhanced query with context */
  enhancedQuery: string;
  
  /** The original user query */
  originalQuery: string;
  
  /** Whether the query was enhanced with RAG context */
  wasEnhanced: boolean;
  
  /** Number of documents used for enhancement */
  documentsUsed: number;
  
  /** Total length of context added */
  contextLength: number;
  
  /** Documents that were found and used */
  documentsFound: RAGDocument[];
}

/**
 * Framework-agnostic RAG provider interface
 * 
 * This interface can be implemented by any database or vector store
 * to provide RAG functionality to the FluidTools system.
 */
export interface RAGProvider {
  /**
   * Search for documents similar to the given query
   * 
   * @param query - The search query text
   * @param options - Optional search configuration
   * @returns Promise resolving to array of similar documents
   */
  searchSimilarDocuments(query: string, options?: RAGSearchOptions): Promise<RAGDocument[]>;

  /**
   * Index a single document for future retrieval
   * 
   * @param document - The document to index
   * @returns Promise that resolves when indexing is complete
   */
  indexDocument(document: RAGDocument): Promise<void>;

  /**
   * Index multiple documents in batch
   * 
   * @param documents - Array of documents to index
   * @returns Promise that resolves when batch indexing is complete
   */
  indexDocuments(documents: RAGDocument[]): Promise<void>;

  /**
   * Remove a document from the index
   * 
   * @param documentId - ID of the document to remove
   * @returns Promise that resolves when deletion is complete
   */
  deleteDocument(documentId: string): Promise<void>;

  /**
   * Check if the RAG provider is available and healthy
   * 
   * @returns Promise resolving to true if available
   */
  isAvailable(): Promise<boolean>;
}