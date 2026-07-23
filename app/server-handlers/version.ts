import { getOptionalBinding } from '~/lib/.server/env';

export function versionAction({ env }: { env: Env }) {
  const sha = getOptionalBinding(env, 'COMMIT_SHA') ?? null;
  const versionId = env.CF_VERSION_METADATA?.id ?? null;
  const oauthConfigured = Boolean(
    getOptionalBinding(env, 'CLOUDFLARE_OAUTH_CLIENT_ID') &&
    getOptionalBinding(env, 'CLOUDFLARE_OAUTH_CLIENT_SECRET') &&
    getOptionalBinding(env, 'CLOUDFLARE_OAUTH_SCOPES'),
  );

  return Response.json({ sha, versionId, oauthConfigured }, { status: 200, headers: { 'Cache-Control': 'no-store' } });
}
