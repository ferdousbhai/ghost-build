import { getAuthSession } from '~/lib/.server/auth';
import { exportControlPlaneAccount } from '~/lib/.server/cloudflare/account-export';

/**
 * The export is not destructive, but one response hands over every operator-held
 * record about a person — identity, email, connected Cloudflare account, granted
 * scopes, runtime address, and sign-in history — in a file that is then kept and
 * forwarded. A borrowed session should reach that no more easily than it reaches
 * erasure, so this gate deliberately matches the deletion gate: a fresh Cloudflare
 * sign-in issues a new session, and that is the re-authentication proof.
 */
export const ACCOUNT_EXPORT_REAUTHENTICATION_WINDOW_MS = 10 * 60_000;

export async function exportAccountAction({ request, env }: { request: Request; env: Env }): Promise<Response> {
  if (request.headers.get('origin') !== new URL(request.url).origin) {
    return Response.json({ error: 'Invalid request origin.' }, { status: 403 });
  }
  const session = await getAuthSession(env, request);
  if (!session) {
    return Response.json({ error: 'Cloudflare authentication required.' }, { status: 401 });
  }
  if (Date.now() - session.session.createdAt > ACCOUNT_EXPORT_REAUTHENTICATION_WINDOW_MS) {
    return Response.json(
      {
        code: 'reauthentication_required',
        error: 'Reconnect Cloudflare to confirm it is you, then download your Ghostbuild account data.',
      },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const account = await exportControlPlaneAccount({ env, userId: session.user.id });
  console.info({
    event: 'control_plane_account_exported',
    exportedAt: account.exportedAt,
    status: account.status,
    unavailableSections: account.unavailableSections,
  });
  // An export that could not read part of itself is still the user's data and is
  // still returned, but it says so in the document rather than looking whole.
  return Response.json(account, { headers: { 'Cache-Control': 'no-store' } });
}
