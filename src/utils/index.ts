export const logger = (debug: boolean, ...messages: unknown[]) => {
  if (!debug) return;
  console.log(...messages);
};
