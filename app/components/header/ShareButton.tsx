import type { ChangeEvent } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { ClipboardIcon, ExternalLinkIcon, ImageIcon, Share2Icon } from '@radix-ui/react-icons';
import { Button } from '@ui/Button';
import { Checkbox } from '@ui/Checkbox';
import { Spinner } from '@ui/Spinner';
import { ThumbnailChooser } from '~/components/workbench/ThumbnailChooser';
import { useShareProject } from './useShareProject';

export function ShareButton() {
  const share = useShareProject();
  return (
    <>
      <Popover.Root open={share.isOpen} onOpenChange={(open) => void share.handleOpenChange(open)}>
        <Popover.Trigger asChild>
          <Button disabled={!share.sharingReady} focused={share.isOpen} variant="neutral" size="xs">
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
            </div>
            <Popover.Arrow className="fill-border-transparent" />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      <ThumbnailChooser isOpen={share.isThumbnailModalOpen} onOpenChange={share.setIsThumbnailModalOpen} />
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
