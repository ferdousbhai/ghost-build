import { useCallback, type ChangeEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as Popover from '@radix-ui/react-popover';
import {
  ChevronRightIcon,
  ClipboardIcon,
  ExternalLinkIcon,
  ImageIcon,
  InfoCircledIcon,
  Share2Icon,
} from '@radix-ui/react-icons';
import { Button } from '@ui/Button';
import { Checkbox } from '@ui/Checkbox';
import { Spinner } from '@ui/Spinner';
import { Tooltip } from '@ui/Tooltip';
import { ThumbnailChooser } from '~/components/workbench/ThumbnailChooser';
import { useShareProject } from './useShareProject';

export function ShareButton() {
  const share = useShareProject();
  const handleRequestCapture = useCallback(() => share.requestCapture(), [share]);
  return (
    <>
      <Popover.Root open={share.isOpen} onOpenChange={(open) => void share.handleOpenChange(open)}>
        <Popover.Trigger asChild>
          <Button disabled={!share.anyPreviewReady} focused={share.isOpen} variant="neutral" size="xs">
            <Share2Icon />
            <span>Share</span>
          </Button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            className="animate-fadeInFromLoading z-50 w-[400px] rounded-md border bg-bolt-elements-background-depth-1 shadow-lg"
            sideOffset={5}
            align="end"
          >
            <div className="flex flex-col gap-4 p-4">
              <div className="space-y-4">
                <label className="group flex cursor-pointer items-start gap-2">
                  <Checkbox
                    id="isShared"
                    checked={share.isSharedDraft}
                    onChange={(event: ChangeEvent<HTMLInputElement>) => share.setIsSharedDraft(event.target.checked)}
                  />
                  <span className="group-hover:text-content-primary block text-sm font-medium">Share project</span>
                </label>
                {share.currentShare?.isShared && <ShareLink url={share.shareUrl} onCopy={share.copyToClipboard} />}
                <div className="flex items-center justify-between">
                  <Button variant="neutral" size="xs" onClick={() => share.setIsThumbnailModalOpen(true)}>
                    {share.currentShare?.thumbnailUrl ? (
                      <div className="relative size-4 overflow-hidden rounded shadow-[0_2px_4px_rgba(0,0,0,0.4)] ring-1 ring-black/10">
                        <img
                          src={share.currentShare.thumbnailUrl}
                          alt="Share thumbnail"
                          className="absolute inset-0 size-full object-cover"
                          crossOrigin="anonymous"
                        />
                      </div>
                    ) : (
                      <ImageIcon />
                    )}
                    <span>Set Thumbnail</span>
                  </Button>
                  <Button
                    variant="neutral"
                    onClick={() => void share.saveSharing()}
                    disabled={share.shareStatus === 'loading' || !share.hasChanges}
                  >
                    {share.shareStatus === 'loading' ? (
                      <>
                        <Spinner className="size-4" />
                        <span>Saving...</span>
                      </>
                    ) : share.hasChanges ? (
                      'Save sharing settings'
                    ) : (
                      'Saved'
                    )}
                  </Button>
                </div>
              </div>
              <MoreSharingOptions share={share} />
            </div>
            <Popover.Arrow className="fill-border-transparent" />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      <Dialog.Root open={share.isThumbnailModalOpen} onOpenChange={share.setIsThumbnailModalOpen}>
        <ThumbnailChooser
          isOpen={share.isThumbnailModalOpen}
          onOpenChange={share.setIsThumbnailModalOpen}
          onRequestCapture={handleRequestCapture}
        />
      </Dialog.Root>
    </>
  );
}

function ShareLink({ url, onCopy }: { url: string; onCopy: (url: string) => void }) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="text"
        readOnly
        value={url}
        className="text-content-primary flex-1 rounded-md border bg-bolt-elements-background-depth-2 px-3 py-1.5 text-sm"
      />
      <Button variant="neutral" size="xs" onClick={() => onCopy(url)} tip="Copy link" icon={<ClipboardIcon />} />
      <Button
        variant="neutral"
        size="xs"
        onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}
        tip="Open in new tab"
        icon={<ExternalLinkIcon />}
      />
    </div>
  );
}

function MoreSharingOptions({ share }: { share: ReturnType<typeof useShareProject> }) {
  return (
    <div className="space-y-4 border-t pt-4">
      <details className="group">
        <summary className="flex cursor-pointer select-none items-center justify-between">
          <div className="flex items-center gap-2">
            <ChevronRightIcon className="size-4 transition-transform group-open:rotate-90" />
            <span className="text-content-secondary group-hover:text-content-primary text-sm">More ways to share</span>
          </div>
        </summary>
        <div className="mt-4 space-y-4">
          <div className="flex items-center justify-start gap-2">
            <Button variant="neutral" onClick={() => void share.createSnapshot()}>
              Create Point-In-Time Snapshot
            </Button>
            <Tooltip tip="Create a link to a specific version of your project that others can clone, including all chat history but without database contents. This can be useful for support tickets.">
              <InfoCircledIcon className="size-4" />
            </Tooltip>
          </div>
          {share.snapshotStatus === 'loading' && (
            <div className="flex flex-col items-center justify-center py-4">
              <Spinner />
              <p className="text-content-secondary text-sm">Creating snapshot…</p>
            </div>
          )}
          {share.snapshotStatus === 'success' && share.snapshotUrl && (
            <div className="space-y-2">
              <p className="text-content-secondary text-sm">Snapshot link:</p>
              <ShareLink url={share.snapshotUrl} onCopy={share.copyToClipboard} />
            </div>
          )}
        </div>
      </details>
    </div>
  );
}
