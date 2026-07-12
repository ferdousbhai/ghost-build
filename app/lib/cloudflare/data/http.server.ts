import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { z } from 'zod';
import { UnauthorizedError } from './auth.server';

const logger = createScopedLogger('CloudflareData');

export function internalErrorResponse(error: unknown, fallback: string): Response {
  if (error instanceof z.ZodError) {
    return Response.json({ error: 'Invalid request', issues: error.issues }, { status: 400 });
  }
  if (error instanceof UnauthorizedError) {
    return Response.json({ error: error.message }, { status: 401 });
  }
  logger.error(error);
  return Response.json({ error: error instanceof Error ? error.message : fallback }, { status: 500 });
}

export function ensureDataBindings(env: Env): void {
  if (!env.DB) {
    throw new Error('Cloudflare D1 binding DB is not configured');
  }
  if (!env.APP_STORAGE) {
    throw new Error('Cloudflare R2 binding APP_STORAGE is not configured');
  }
}

export function parseRequestQuery<Schema extends z.ZodType>(request: Request, schema: Schema): z.output<Schema> {
  return schema.parse(Object.fromEntries(new URL(request.url).searchParams));
}
