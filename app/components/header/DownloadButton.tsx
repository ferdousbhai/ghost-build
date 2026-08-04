import { DownloadIcon } from '@radix-ui/react-icons';
import { workbenchStore } from '~/lib/stores/workbench.client';
import { Button } from '@ui/Button';

export function DownloadButton() {
  return (
    <Button
      onClick={() => workbenchStore.downloadZip()}
      variant="neutral"
      size="xs"
      className="!size-11 !min-h-11 !px-0 sm:!size-auto sm:!min-h-7 sm:!px-2"
      aria-label="Download code"
      tip="Download code"
    >
      <DownloadIcon />
      <span className="hidden md:inline">Download Code</span>
    </Button>
  );
}
