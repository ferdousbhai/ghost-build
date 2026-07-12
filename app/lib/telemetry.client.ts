type TelemetryUser = { id?: string; username?: string; email?: string };
type TelemetryContext = Record<string, unknown>;

const extras: Record<string, unknown> = {};
let user: TelemetryUser | undefined;

export async function captureMessage(message: string, context?: TelemetryContext): Promise<void> {
  console.warn(message, context);
  emitTelemetry({ kind: 'message', message, context });
}

export async function captureException(error: unknown, context?: TelemetryContext): Promise<void> {
  console.error(error, context);
  const normalized = normalizeError(error);
  emitTelemetry({ kind: 'exception', message: normalized.message, error: normalized, context });
}

export function setTelemetryExtra(key: string, value: unknown): void {
  extras[key] = value;
}

export function setTelemetryUser(nextUser: TelemetryUser | undefined): void {
  user = nextUser;
}

export async function openFeedbackForm(): Promise<void> {
  const message = window.prompt('What would you like Ghostbuild to improve?')?.trim();
  if (!message) {
    return;
  }
  emitTelemetry({ kind: 'feedback', message });
}

function emitTelemetry(event: {
  kind: 'message' | 'exception' | 'feedback';
  message: string;
  error?: ReturnType<typeof normalizeError>;
  context?: TelemetryContext;
}): void {
  if (typeof navigator === 'undefined') {
    return;
  }
  const body = JSON.stringify({
    ...event,
    extras: { ...extras },
    user,
    page: typeof window === 'undefined' ? undefined : window.location.href,
    timestamp: new Date().toISOString(),
  });
  if (navigator.sendBeacon?.('/api/client-telemetry', new Blob([body], { type: 'application/json' }))) {
    return;
  }
  void fetch('/api/client-telemetry', {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json' },
    keepalive: true,
  }).catch((sendError) => console.error('Failed to send client telemetry', sendError));
}

function normalizeError(error: unknown): { name?: string; message: string; stack?: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { message: String(error) };
}
