export const logger = (debug: boolean, ...messages: unknown[]) => {
  if (!debug) return;
  console.info(...messages);
};
