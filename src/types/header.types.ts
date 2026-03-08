export type HeaderResolver = (
  toolName: string,
  accessToken: string | undefined
) => Record<string, string>;
