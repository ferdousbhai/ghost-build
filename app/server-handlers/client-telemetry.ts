import { z } from 'zod';
import { InvalidJsonBodyError, PayloadTooLargeError, readJsonBodyWithLimit } from '~/lib/bounded-body';
import { CLIENT_TELEMETRY_EVENTS } from '~/lib/client-telemetry-events';

const MAX_TELEMETRY_BYTES = 64 * 1024;
const TELEMETRY_RATE_LIMIT_BINDING = 'CLIENT_TELEMETRY_RATE_LIMITER';
const telemetryEventSchema = z
  .object({
    kind: z.enum(['message', 'exception']),
    event: z.enum(CLIENT_TELEMETRY_EVENTS),
    context: z
      .object({ level: z.enum(['error', 'warning', 'info']).optional() })
      .strict()
      .optional(),
  })
  .strict();

export async function clientTelemetryAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  if (request.headers.get('Origin') !== new URL(request.url).origin) {
    return new Response(null, { status: 403 });
  }
  const limiter = env[TELEMETRY_RATE_LIMIT_BINDING];
  const { success } = await limiter.limit({ key: request.headers.get('CF-Connecting-IP') ?? 'unknown' });
  if (!success) {
    return new Response(null, {
      status: 429,
      headers: { 'Retry-After': '60', 'Cache-Control': 'no-store' },
    });
  }
  let body: unknown;
  try {
    body = await readJsonBodyWithLimit(request, MAX_TELEMETRY_BYTES, 'Telemetry event');
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return new Response(null, { status: 413 });
    }
    if (!(error instanceof InvalidJsonBodyError)) {
      console.error('Unable to read Ghostbuild client telemetry', error);
      return new Response(null, { status: 500 });
    }
    return Response.json({ error: 'Invalid telemetry event' }, { status: 400 });
  }
  const event = telemetryEventSchema.safeParse(body);
  if (!event.success) {
    return Response.json({ error: 'Invalid telemetry event' }, { status: 400 });
  }
  if (event.data.kind === 'exception') {
    console.error('Ghostbuild client telemetry', event.data);
  } else {
    console.warn('Ghostbuild client telemetry', event.data);
  }
  return new Response(null, { status: 204 });
}
