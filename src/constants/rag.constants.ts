/**
 * RAG System Constants
 * 
 * This file contains all constants used by the RAG system.
 */

/**
 * Default configuration values for RAG
 */
export const RAG_DEFAULTS = {
  /** Default maximum number of documents to retrieve */
  MAX_DOCUMENTS: 5,
  
  /** Default similarity threshold */
  SIMILARITY_THRESHOLD: 0.3,
  
  /** Default context window size in characters */
  CONTEXT_WINDOW: 4000,
  
  /** Default search limit */
  SEARCH_LIMIT: 10,
} as const;

/**
 * RAG system messages and templates
 */
export const RAG_MESSAGES = {
  /** Template for combining query with retrieved context */
  CONTEXT_TEMPLATE: `Context Information:
{context}

User Query: {query}

IMPORTANT: Please answer the user query using the provided context information when relevant. If you use information from the context, please mention that you're referencing specific documentation or knowledge base. If the context doesn't contain relevant information, clearly state that you're providing general knowledge and not specific documentation.`,

  /** Message when no context is available */
  NO_CONTEXT_AVAILABLE: 'No relevant context found in knowledge base.',
  
  /** Message when RAG is disabled */
  RAG_DISABLED: 'RAG system is not available.',
} as const;

/**
 * Logging prefixes for consistent log formatting
 */
export const RAG_LOG_PREFIXES = {
  SERVICE: '[RAGService]',
  PROVIDER: '[RAGProvider]',
  SEARCH: '[RAGSearch]',
  INDEX: '[RAGIndex]',
} as const;