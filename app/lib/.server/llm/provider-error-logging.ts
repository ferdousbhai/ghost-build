type ErrorLogger = {
  error: (message: string) => void;
};

export function logProviderFailure(logger: ErrorLogger, event: string, _error: unknown): void {
  logger.error(event);
}
