export type PublicRuntimeConfig = {
  cloudflareSiteUrl: string;
  posthog: {
    key: string;
    host: string;
  };
  sentry: {
    dsn: string;
  };
};

let cachedPublicRuntimeConfig: PublicRuntimeConfig | null = null;
let pendingPublicRuntimeConfig: Promise<PublicRuntimeConfig> | null = null;

export function getCachedPublicRuntimeConfig() {
  return cachedPublicRuntimeConfig;
}

export async function loadPublicRuntimeConfig(): Promise<PublicRuntimeConfig> {
  if (cachedPublicRuntimeConfig) {
    return cachedPublicRuntimeConfig;
  }

  pendingPublicRuntimeConfig ??= fetch('/api/public-config', {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
  })
    .then((response) => {
      if (!response.ok) {
        throw new Error(`Failed to load public Cloudflare config: ${response.status}`);
      }
      return response.json() as Promise<PublicRuntimeConfig>;
    })
    .then((config) => {
      cachedPublicRuntimeConfig = config;
      return config;
    })
    .finally(() => {
      pendingPublicRuntimeConfig = null;
    });

  return pendingPublicRuntimeConfig;
}
