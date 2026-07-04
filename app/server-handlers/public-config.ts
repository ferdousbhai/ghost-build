import { getOptionalBinding } from '~/lib/.server/env';
import type { PublicRuntimeConfig } from '~/lib/publicConfig';

export function publicConfigAction({ request, env }: { request: Request; env: Env }) {
  const origin = new URL(request.url).origin;
  const config: PublicRuntimeConfig = {
    cloudflareSiteUrl: getOptionalBinding(env, 'CLOUDFLARE_SITE_URL') ?? origin,
    posthog: {
      key: getOptionalBinding(env, 'POSTHOG_KEY') ?? '',
      host: getOptionalBinding(env, 'POSTHOG_HOST') ?? '',
    },
    sentry: {
      dsn: getOptionalBinding(env, 'SENTRY_DSN') ?? '',
    },
  };

  return Response.json(config, {
    headers: {
      'Cache-Control': 'private, max-age=60',
    },
  });
}
