import type { ClientTelemetryEvent } from './client-telemetry-events';

type TelemetryContext = { level?: 'error' | 'warning' | 'info' };

export async function captureMessage(event: ClientTelemetryEvent, context?: TelemetryContext): Promise<void> {
  console.warn(event, context);
  emitTelemetry({ kind: 'message', event, context });
}

export async function captureException(
  event: ClientTelemetryEvent,
  error: unknown,
  context?: TelemetryContext,
): Promise<void> {
  console.error(error, context);
  emitTelemetry({ kind: 'exception', event, context });
}

function emitTelemetry(event: {
  kind: 'message' | 'exception';
  event: ClientTelemetryEvent;
  context?: TelemetryContext;
}): void {
  if (typeof navigator === 'undefined') {
    return;
  }
  const body = JSON.stringify({
    kind: event.kind,
    event: event.event,
    context: event.context,
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
