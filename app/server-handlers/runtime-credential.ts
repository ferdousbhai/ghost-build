import { z } from 'zod';
import { InvalidJsonBodyError, PayloadTooLargeError, readJsonBodyWithLimit } from '~/lib/bounded-body';
import { requireActiveCloudflareConnection } from '~/lib/.server/cloudflare/cloudflare-connection-repository';
import { D1CloudflareCredentialVault } from '~/lib/.server/cloudflare/cloudflare-credential-vault';
import { deriveUserWorkspaceRuntimeSecret } from '~/lib/.server/cloudflare/user-workspace-runtime-secret';

const MAX_RUNTIME_CREDENTIAL_REQUEST_BYTES = 4 * 1024;
const runtimeCredentialRequestSchema = z
  .object({
    userId: z.string().min(1).max(512),
    connectionId: z.string().min(1).max(512),
    connectionGeneration: z.number().int().positive(),
    forceRefresh: z.boolean().optional().default(false),
  })
  .strict();

/** Exchange a runtime-specific secret for a freshly resolved OAuth access token. */
export async function runtimeCredentialAction(args: { request: Request; env: Env }): Promise<Response> {
  let body: z.infer<typeof runtimeCredentialRequestSchema>;
  try {
    body = runtimeCredentialRequestSchema.parse(
      await readJsonBodyWithLimit(
        args.request,
        MAX_RUNTIME_CREDENTIAL_REQUEST_BYTES,
        'Workspace runtime credential request',
      ),
    );
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return credentialResponse({ error: error.message }, 413);
    }
    if (error instanceof InvalidJsonBodyError || error instanceof z.ZodError) {
      return credentialResponse({ error: 'Invalid workspace runtime credential request.' }, 400);
    }
    throw error;
  }

  const encryptionKey = args.env.CLOUDFLARE_CREDENTIAL_ENCRYPTION_KEY;
  const bearer = readBearerToken(args.request);
  if (!encryptionKey || !bearer) {
    return credentialResponse({ error: 'Unauthorized.' }, 401);
  }

  let connection;
  try {
    connection = await requireActiveCloudflareConnection(args.env.DB, body.connectionId);
  } catch {
    return credentialResponse({ error: 'Unauthorized.' }, 401);
  }
  if (
    connection.userId !== body.userId ||
    connection.generation !== body.connectionGeneration ||
    !connection.credentialHandle
  ) {
    return credentialResponse({ error: 'Unauthorized.' }, 401);
  }

  let expected: string;
  try {
    expected = await deriveUserWorkspaceRuntimeSecret({
      encryptionKeyBase64: encryptionKey,
      userId: body.userId,
      accountId: connection.accountId,
      connectionGeneration: body.connectionGeneration,
    });
  } catch (error) {
    console.error('Unable to derive the user workspace runtime credential', {
      error: error instanceof Error ? error.message : String(error),
    });
    return credentialResponse({ error: 'Cloudflare connection is unavailable.' }, 503);
  }
  if (!constantTimeEqual(bearer, expected)) {
    return credentialResponse({ error: 'Unauthorized.' }, 401);
  }

  try {
    const accessToken = await D1CloudflareCredentialVault.fromEnv(args.env).resolve(connection.credentialHandle, {
      forceRefresh: body.forceRefresh,
    });
    return credentialResponse({ accessToken }, 200);
  } catch (error) {
    console.error('Unable to resolve the user workspace runtime credential', {
      error: error instanceof Error ? error.message : String(error),
    });
    return credentialResponse({ error: 'Cloudflare connection is unavailable.' }, 503);
  }
}

function readBearerToken(request: Request): string | null {
  const header = request.headers.get('Authorization');
  if (!header?.startsWith('Bearer ')) {
    return null;
  }
  const token = header.slice(7);
  return token.length >= 32 && token.length <= 512 ? token : null;
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function credentialResponse(body: Record<string, string>, status: number): Response {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}
