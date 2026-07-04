import { QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import useVersionNotificationBanner from '~/components/VersionNotificationBanner';
import { queryClient } from '~/lib/stores/reactQueryClient';
import { getCachedPublicRuntimeConfig, loadPublicRuntimeConfig, type PublicRuntimeConfig } from '~/lib/publicConfig';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { initTelemetry } from '~/lib/telemetry.client';

const logger = createScopedLogger('AppProviders');

export function AppProviders({ children }: { children: ReactNode }) {
  const [publicConfig, setPublicConfig] = useState<PublicRuntimeConfig | null>(() => getCachedPublicRuntimeConfig());

  useEffect(() => {
    let cancelled = false;
    loadPublicRuntimeConfig()
      .then((config) => {
        if (!cancelled) {
          setPublicConfig(config);
        }
      })
      .catch((error) => {
        logger.error('Failed to load Cloudflare public runtime config', error);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!publicConfig) {
      return;
    }
    initTelemetry(publicConfig).catch((error) => {
      logger.error('Failed to initialize telemetry', error);
    });
  }, [publicConfig]);

  const content = publicConfig ? (
    <>
      <VersionNotificationEffect />
      {children}
    </>
  ) : null;

  return <QueryClientProvider client={queryClient}>{content}</QueryClientProvider>;
}

function VersionNotificationEffect() {
  useVersionNotificationBanner();
  return null;
}
