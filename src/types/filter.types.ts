export interface ContentFilter {
  input?: (query: string) => string | Promise<string>;
  output?: (toolName: string, response: string) => string | Promise<string>;
}
