/** The non-identifying facts about a provider failure that are safe to record in an operator log. */
type ProviderFailureMetadata = {
  kind: string;
  status?: number;
  statusText?: string;
  diagnosticCode?: string;
};

type ErrorLogger = {
  error: (message: string, data?: ProviderFailureMetadata) => void;
};

export function logProviderFailure(logger: ErrorLogger, event: string, error: unknown): void {
  logger.error(event, providerFailureMetadata(error));
}

function providerFailureMetadata(error: unknown): ProviderFailureMetadata {
  if (error instanceof Response) {
    return {
      kind: 'Response',
      status: error.status,
      statusText: error.statusText,
    };
  }
  if (error instanceof Error) {
    const diagnosticCode = readDiagnosticCode(error);
    if (diagnosticCode) {
      return { kind: error.name, diagnosticCode };
    }
    return { kind: error.name };
  }
  return { kind: typeof error };
}

function readDiagnosticCode(error: Error): string | undefined {
  if (!('diagnosticCode' in error)) {
    return undefined;
  }
  const { diagnosticCode } = error;
  return typeof diagnosticCode === 'string' && /^[a-z0-9_:-]{1,64}$/.test(diagnosticCode) ? diagnosticCode : undefined;
}
