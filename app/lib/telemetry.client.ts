import type { ClientTelemetryEvent } from './client-telemetry-events';

type TelemetryContext = { level?: 'error' | 'warning' | 'info' };

export async function captureMessage(event: ClientTelemetryEvent, context?: TelemetryContext): Promise<void> {
  console.warn(event, context);
}

export async function captureException(
  event: ClientTelemetryEvent,
  error: unknown,
  context?: TelemetryContext,
): Promise<void> {
  console.error(error, context);
}
