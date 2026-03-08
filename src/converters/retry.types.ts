export interface RetryConfig {
  maxRetries?: number;
  retryDelayMs?: number;
  retryOnStatusCodes?: number[];
}
