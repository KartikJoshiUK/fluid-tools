/**
 * Query log entry structure
 */
export interface QueryLog {
  clientId: number;
  threadId: string;
  query: string;
  metadata?: {
    projectId?: string;
    region?: string;
  };
  error: boolean;
  created_at: Date;
}

/**
 * Query metadata passed with each query
 */
export interface QueryMetadata {
  clientId?: number;
  projectId?: string;
  region?: string;
}

/**
 * Query provider interface for logging queries
 */
export interface QueryProvider {
  /**
   * Log a query to the storage backend
   */
  logQuery(queryLog: QueryLog): Promise<void>;

  /**
   * Check if the provider is available
   */
  isAvailable(): Promise<boolean>;
}

/**
 * Configuration for query tracking
 */
export interface QueryConfig {
  enabled: boolean;
  includeMetadata?: boolean;
}
