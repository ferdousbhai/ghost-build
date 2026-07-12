import { z } from 'zod';

const MAX_TELEMETRY_BYTES = 64 * 1024;
const telemetryEventSchema = z.object({
  kind: z.enum(['message', 'exception', 'feedback']),
  message: z.string().max(16_000),
  error: z
    .object({
      name: z.string().optional(),
      message: z.string(),
      stack: z.string().max(32_000).optional(),
    })
    .optional(),
  context: z.record(z.string(), z.unknown()).optional(),
  extras: z.record(z.string(), z.unknown()).optional(),
  user: z
    .object({
      id: z.string().optional(),
      username: z.string().optional(),
      email: z.string().optional(),
    })
    .optional(),
  page: z.string().optional(),
  timestamp: z.string().optional(),
});

export async function clientTelemetryAction(request: Request): Promise<Response> {
  const declaredLength = Number(request.headers.get('content-length') ?? 0);
  if (declaredLength > MAX_TELEMETRY_BYTES) {
    return new Response(null, { status: 413 });
  }
  const rawBody = await request.text();
  if (new TextEncoder().encode(rawBody).byteLength > MAX_TELEMETRY_BYTES) {
    return new Response(null, { status: 413 });
  }
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return Response.json({ error: 'Invalid telemetry event' }, { status: 400 });
  }
  const event = telemetryEventSchema.safeParse(body);
  if (!event.success) {
    return Response.json({ error: 'Invalid telemetry event' }, { status: 400 });
  }
  if (event.data.kind === 'exception') {
    console.error('Ghostbuild client telemetry', event.data);
  } else if (event.data.kind === 'feedback') {
    console.info('Ghostbuild client telemetry', event.data);
  } else {
    console.warn('Ghostbuild client telemetry', event.data);
  }
  return new Response(null, { status: 204 });
}
