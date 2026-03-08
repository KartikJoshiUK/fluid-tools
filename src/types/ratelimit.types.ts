export interface RateLimitConfig {
  maxQueriesPerWindow?: number;
  windowMs?: number;
  maxConcurrentQueries?: number;
}
