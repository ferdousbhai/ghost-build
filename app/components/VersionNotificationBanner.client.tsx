import { toast } from 'sonner';
import { Button } from '@ui/Button';
import { SymbolIcon } from '@radix-ui/react-icons';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { captureMessage } from '~/lib/telemetry.client';

export function VersionNotificationEffect() {
  const loadedVersionSha = useRef<string | null | undefined>(undefined);
  const { data, error } = useQuery({
    queryKey: ['ghostbuild-version'],
    queryFn: ({ signal }) => versionFetcher('/api/version', signal),
    refetchInterval: 1000 * 60 * 60,
    staleTime: 1000 * 60 * 10,
    refetchOnWindowFocus: true,
    retry: false,
  });

  useEffect(() => {
    if (error || data === undefined) {
      return;
    }

    const latestSha = data.sha ?? null;
    if (loadedVersionSha.current === undefined) {
      loadedVersionSha.current = latestSha;
      return;
    }

    if (!loadedVersionSha.current || !latestSha || latestSha === loadedVersionSha.current) {
      return;
    }

    toast.info(
      <div className="flex flex-col">
        A new version of Ghostbuild is available! Refresh this page to update.
        <Button
          className="ml-auto w-fit items-center"
          inline
          size="xs"
          icon={<SymbolIcon />}
          onClick={() => window.location.reload()}
        >
          Refresh
        </Button>
      </div>,
      {
        id: 'ghostbuildVersion',
        duration: Number.POSITIVE_INFINITY,
      },
    );
  }, [data, error]);

  return null;
}

const versionFetcher = async (url: string, signal: AbortSignal): Promise<{ sha?: string | null }> => {
  const res = await fetch(url, { signal });

  if (!res.ok) {
    try {
      const { error } = (await res.json()) as { error?: string };
      console.warn(error ?? 'Failed to fetch dashboard version information.');
      captureMessage('Failed to fetch dashboard version information');
    } catch (_e) {
      captureMessage('Failed to fetch dashboard version information');
    }
    throw new Error('Failed to fetch dashboard version information.');
  }
  return (await res.json()) as { sha?: string | null };
};
