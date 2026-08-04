import type { ClientTelemetryEvent, ProductTelemetryEvent } from './client-telemetry-events';

type TelemetryContext = {
  level?: 'error' | 'warning' | 'info';
  outcome?: 'success' | 'failure' | 'cancelled';
  failureReason?: 'authorization' | 'network' | 'timeout' | 'validation' | 'deployment' | 'unknown';
  durationMs?: number;
  retryCount?: number;
  workspaceRevision?: number;
};

const TELEMETRY_ENDPOINT = '/api/client-telemetry';
const JOURNEY_STORAGE_KEY = 'ghostbuild:telemetry:journey';
const ONCE_PER_JOURNEY_EVENTS = new Set<ProductTelemetryEvent>([
  'landing_viewed',
  'cloudflare_connect_started',
  'first_tool_completed',
  'validation_succeeded',
  'preview_ready',
  'deployment_approval_presented',
  'deployment_approved',
  'deployment_succeeded',
]);

export async function captureMessage(event: ClientTelemetryEvent, context?: TelemetryContext): Promise<void> {
  console.warn(event, context);
  await emitTelemetry(event, context);
}

export async function captureException(
  event: ClientTelemetryEvent,
  error: unknown,
  context?: TelemetryContext,
): Promise<void> {
  console.error(error, context);
  await emitTelemetry(event, { ...context, level: context?.level ?? 'error', outcome: 'failure' });
}

export async function captureProductEvent(event: ProductTelemetryEvent, context?: TelemetryContext): Promise<void> {
  if (ONCE_PER_JOURNEY_EVENTS.has(event) && !claimOncePerJourney(event)) {
    return;
  }
  await emitTelemetry(event, context);
}

async function emitTelemetry(
  event: ClientTelemetryEvent | ProductTelemetryEvent,
  context: TelemetryContext = {},
): Promise<void> {
  if (!telemetryEnabled()) {
    return;
  }
  const level = context.level ?? 'info';
  const payload = JSON.stringify({
    schemaVersion: 1,
    event,
    level,
    journeyId: journeyId(),
    ...(level === 'error' ? { errorEventId: crypto.randomUUID() } : {}),
    occurredAt: new Date().toISOString(),
    page: pageKind(),
    context: sanitizeContext(context),
  });
  try {
    await fetch(TELEMETRY_ENDPOINT, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'content-type': 'application/json' },
      body: payload,
      keepalive: true,
    });
  } catch {
    // Telemetry is deliberately best-effort and must never interrupt the product journey.
  }
}

function sanitizeContext(context: TelemetryContext) {
  return {
    ...(context.outcome ? { outcome: context.outcome } : {}),
    ...(context.failureReason ? { failureReason: context.failureReason } : {}),
    ...(validMetric(context.durationMs) ? { durationMs: context.durationMs } : {}),
    ...(validMetric(context.retryCount) ? { retryCount: context.retryCount } : {}),
    ...(validMetric(context.workspaceRevision) ? { workspaceRevision: context.workspaceRevision } : {}),
  };
}

function validMetric(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function telemetryEnabled(): boolean {
  const privacyNavigator = navigator as Navigator & { globalPrivacyControl?: boolean };
  if (privacyNavigator.globalPrivacyControl === true || privacyNavigator.doNotTrack === '1') {
    return false;
  }
  return safeSessionStorageGet('ghostbuild:telemetry:disabled') !== 'true';
}

function journeyId(): string {
  const existing = safeSessionStorageGet(JOURNEY_STORAGE_KEY);
  if (existing && /^[0-9a-f-]{36}$/i.test(existing)) {
    return existing;
  }
  const created = crypto.randomUUID();
  safeSessionStorageSet(JOURNEY_STORAGE_KEY, created);
  return created;
}

function claimOncePerJourney(event: ProductTelemetryEvent): boolean {
  const key = `ghostbuild:telemetry:once:${event}`;
  if (safeSessionStorageGet(key) === 'true') {
    return false;
  }
  safeSessionStorageSet(key, 'true');
  return true;
}

function safeSessionStorageGet(key: string): string | null {
  try {
    return window.sessionStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function safeSessionStorageSet(key: string, value: string): void {
  try {
    window.sessionStorage?.setItem(key, value);
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
}

function pageKind(): 'home' | 'settings' | 'chat' | 'other' {
  const pathname = window.location.pathname;
  if (pathname === '/') {
    return 'home';
  }
  if (pathname === '/settings') {
    return 'settings';
  }
  if (pathname.startsWith('/chat/')) {
    return 'chat';
  }
  return 'other';
}
