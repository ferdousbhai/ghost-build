type ErrorLogger = {
  error: (message: string, data?: Record<string, unknown>) => void;
};

export function logProviderFailure(logger: ErrorLogger, event: string, error: unknown): void {
  logger.error(event, providerFailureMetadata(error));
}

function providerFailureMetadata(error: unknown): Record<string, unknown> {
  if (error instanceof Response) {
    return {
      kind: 'Response',
      status: error.status,
      statusText: error.statusText,
    };
  }
  if (error instanceof Error) {
    const diagnosticCode = readDiagnosticCode(error);
    return {
      kind: error.name,
      ...(diagnosticCode ? { diagnosticCode } : {}),
    };
  }
  return { kind: typeof error };
}

function readDiagnosticCode(error: Error): string | undefined {
  const value = (error as Error & { diagnosticCode?: unknown }).diagnosticCode;
  return typeof value === 'string' && /^[a-z0-9_:-]{1,64}$/.test(value) ? value : undefined;
}
