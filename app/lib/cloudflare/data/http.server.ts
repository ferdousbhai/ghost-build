import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { z } from 'zod';
import { UnauthorizedError } from './auth.server';
import { ChatStorageRetentionError, DataNotFoundError, SubchatLimitError } from './errors';
import { InvalidJsonBodyError, PayloadTooLargeError } from '~/lib/bounded-body';
import { InvalidMultipartBodyError } from '~/lib/bounded-multipart';
import { Lz4PayloadError } from '~/lib/compression-limits';
import { ChatBackupQuotaError } from './chat-backup-quota.server';

const logger = createScopedLogger('CloudflareData');

export function internalErrorResponse(error: unknown, fallback: string): Response {
  if (error instanceof z.ZodError) {
    return Response.json({ error: 'Invalid request', issues: error.issues }, { status: 400 });
  }
  if (error instanceof UnauthorizedError) {
    return Response.json({ error: error.message }, { status: 401 });
  }
  if (error instanceof DataNotFoundError) {
    return Response.json({ error: error.message }, { status: 404 });
  }
  if (error instanceof ChatStorageRetentionError) {
    return Response.json({ error: error.message }, { status: 409 });
  }
  if (error instanceof ChatBackupQuotaError) {
    const headers = error.retryAfterSeconds ? { 'Retry-After': String(error.retryAfterSeconds) } : undefined;
    const status = error.kind === 'storage' ? 409 : error.kind === 'not-ready' ? 503 : 429;
    return Response.json({ error: error.message }, { status, headers });
  }
  if (error instanceof SubchatLimitError) {
    return Response.json({ error: error.message }, { status: 409 });
  }
  if (error instanceof PayloadTooLargeError) {
    return Response.json({ error: error.message }, { status: 413 });
  }
  if (error instanceof InvalidJsonBodyError || error instanceof InvalidMultipartBodyError) {
    return Response.json({ error: error.message }, { status: 400 });
  }
  if (error instanceof Lz4PayloadError) {
    return Response.json({ error: error.message }, { status: error.kind === 'too-large' ? 413 : 400 });
  }
  logger.error(error);
  return Response.json({ error: fallback }, { status: 500 });
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
