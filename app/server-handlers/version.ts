import { getOptionalBinding } from '~/lib/.server/env';

export function versionAction({ env }: { env: Env }) {
  const sha =
    getOptionalBinding(env, 'WORKERS_CI_COMMIT_SHA') ??
    getOptionalBinding(env, 'COMMIT_SHA') ??
    getOptionalBinding(env, 'GITHUB_SHA') ??
    null;

  return Response.json({ sha }, { status: 200 });
}
