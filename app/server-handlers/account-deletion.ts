import { z } from 'zod';
import { clearAuthSessionCookie, getAuthSession } from '~/lib/.server/auth';
import { eraseControlPlaneAccount } from '~/lib/.server/cloudflare/account-deletion';
import { readJsonBodyWithLimit } from '~/lib/bounded-body';
import { ACCOUNT_DELETION_CONFIRMATION } from '~/lib/account-data';

/**
 * Erasure is irreversible, so it is accepted only from a session that was created
 * by a fresh Cloudflare sign-in. Reconnecting Cloudflare issues a new session,
 * which is the re-authentication proof this window checks.
 */
export const ACCOUNT_DELETION_REAUTHENTICATION_WINDOW_MS = 10 * 60_000;
const MAX_ACCOUNT_DELETION_BYTES = 1024;
const accountDeletionSchema = z
  .object({
    confirmation: z.literal(ACCOUNT_DELETION_CONFIRMATION),
    acknowledgeCloudflareResourcesRetained: z.literal(true),
  })
  .strict();

export async function deleteAccountAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  if (request.headers.get('origin') !== new URL(request.url).origin) {
    return Response.json({ error: 'Invalid request origin.' }, { status: 403 });
  }
  const session = await getAuthSession(env, request);
  if (!session) {
    return Response.json({ error: 'Cloudflare authentication required.' }, { status: 401 });
  }
  if (Date.now() - session.session.createdAt > ACCOUNT_DELETION_REAUTHENTICATION_WINDOW_MS) {
    return Response.json(
      {
        code: 'reauthentication_required',
        error: 'Reconnect Cloudflare to confirm it is you, then delete your Ghostbuild account data.',
      },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  const confirmation = accountDeletionSchema.safeParse(
    await readJsonBodyWithLimit(request, MAX_ACCOUNT_DELETION_BYTES, 'Account deletion request').catch(() => null),
  );
  if (!confirmation.success) {
    return Response.json(
      { error: 'Confirm the exact phrase and the retained-resources acknowledgement.' },
      { status: 400 },
    );
  }

  const erasure = await eraseControlPlaneAccount({ env, userId: session.user.id });
  console.info({
    event: 'control_plane_account_erased',
    erasedAt: new Date().toISOString(),
    cloudflareAuthorizationRevoked: erasure.cloudflareAuthorizationRevoked,
  });
  return Response.json(
    { status: 'deleted', cloudflareAuthorizationRevoked: erasure.cloudflareAuthorizationRevoked },
    { headers: { 'Set-Cookie': clearAuthSessionCookie(request), 'Cache-Control': 'no-store' } },
  );
}
