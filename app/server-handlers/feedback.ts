import { z } from 'zod';
import { getAuthSession } from '~/lib/.server/auth';
import { getOptionalBinding } from '~/lib/.server/env';
import { InvalidJsonBodyError, PayloadTooLargeError, readJsonBodyWithLimit } from '~/lib/bounded-body';

const MAX_SUBMISSIONS_PER_HOUR = 5;
const ONE_HOUR_MS = 60 * 60 * 1000;
const MAX_FEEDBACK_REQUEST_BYTES = 8 * 1024;

const feedbackRequestSchema = z.object({
  category: z.enum(['bug', 'idea', 'ux', 'other']),
  message: z.string().trim().min(3).max(4_000),
  pagePath: z.string().trim().max(1_000).optional(),
});

export async function feedbackAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  if (request.headers.get('Origin') !== new URL(request.url).origin) {
    return Response.json({ error: 'Invalid request origin.' }, { status: 403 });
  }
  let rawBody: unknown;
  try {
    rawBody = await readJsonBodyWithLimit(request, MAX_FEEDBACK_REQUEST_BYTES, 'Feedback request');
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return Response.json({ error: error.message }, { status: 413 });
    }
    if (error instanceof InvalidJsonBodyError) {
      return Response.json({ error: 'Please provide valid feedback.' }, { status: 400 });
    }
    return Response.json({ error: 'Unable to read feedback right now.' }, { status: 500 });
  }
  const parsed = feedbackRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return Response.json({ error: 'Please provide valid feedback.' }, { status: 400 });
  }

  try {
    const userId = await getOptionalUserId(env, request);
    const sourceKey = userId ? `user:${userId}` : `guest:${await hashSource(request)}`;
    const now = Date.now();
    const id = crypto.randomUUID();
    const appVersion = getOptionalBinding(env, 'COMMIT_SHA') ?? null;

    const result = await env.DB.prepare(
      `INSERT INTO feedback
        (id, user_id, category, message, page_path, app_version, status, source_key, created_at)
       SELECT ?, ?, ?, ?, ?, ?, 'new', ?, ?
       WHERE (
         SELECT COUNT(*) FROM feedback WHERE source_key = ? AND created_at >= ?
       ) < ?`,
    )
      .bind(
        id,
        userId,
        parsed.data.category,
        parsed.data.message,
        parsed.data.pagePath ?? null,
        appVersion,
        sourceKey,
        now,
        sourceKey,
        now - ONE_HOUR_MS,
        MAX_SUBMISSIONS_PER_HOUR,
      )
      .run();

    if (result.meta.changes !== 1) {
      return Response.json({ error: 'Too many submissions. Please try again later.' }, { status: 429 });
    }

    return Response.json({ id }, { status: 201 });
  } catch (error) {
    console.error('Unable to save feedback', error);
    return Response.json({ error: 'Unable to save feedback right now.' }, { status: 500 });
  }
}

async function getOptionalUserId(env: Env, request: Request): Promise<string | null> {
  try {
    const session = await getAuthSession(env, request);
    return session?.user.id ?? null;
  } catch {
    return null;
  }
}

async function hashSource(request: Request): Promise<string> {
  const source = request.headers.get('CF-Connecting-IP') ?? request.headers.get('x-forwarded-for') ?? 'unknown';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`ghostbuild-feedback:${source}`));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
