/**
 * Cleans webcontainer URLs from stack traces to show relative paths instead
 */
export function cleanStackTrace(stackTrace: string): string {
  return stackTrace.replace(/https?:\/\/[^/]+\.webcontainer-api\.io\/([^\s)]+)/g, (_, path) => path);
}
