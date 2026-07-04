import { useState, useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import * as Popover from '@radix-ui/react-popover';
import { useMutation, useQuery } from '~/lib/cloudflare/data-hooks';
import { api } from '~/lib/cloudflare/data-api';
import { useSessionId } from '~/lib/stores/sessionId';
import { useChatId } from '~/lib/stores/chatId';
import {
  Share2Icon,
  ClipboardIcon,
  InfoCircledIcon,
  ImageIcon,
  ExternalLinkIcon,
  ChevronRightIcon,
} from '@radix-ui/react-icons';
import { Spinner } from '@ui/Spinner';
import { Button } from '@ui/Button';
import { Tooltip } from '@ui/Tooltip';
import { Checkbox } from '@ui/Checkbox';
import type { ChangeEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { ThumbnailChooser, uploadThumbnail } from '~/components/workbench/ThumbnailChooser';
import { workbenchStore } from '~/lib/stores/workbench.client';
import { useStore } from '@nanostores/react';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { captureException } from '~/lib/telemetry.client';

const logger = createScopedLogger('ShareButton');

type ShareStatus = 'idle' | 'loading' | 'success';
type SnapshotStatus = 'idle' | 'loading' | 'success';

function shareUrlForCode(code: string) {
  const { origin } = window.location;
  return origin === 'https://ghostbuild.dev' ? `https://ghostbuild.dev/share/${code}` : `${origin}/share/${code}`;
}

export function ShareButton() {
  const [isOpen, setIsOpen] = useState(false);
  const [isThumbnailModalOpen, setIsThumbnailModalOpen] = useState(false);
  const [snapshotStatus, setSnapshotStatus] = useState<SnapshotStatus>('idle');
  const [shareStatus, setShareStatus] = useState<ShareStatus>('idle');
  const [snapshotUrl, setSnapshotUrl] = useState('');
  const [shareUrl, setShareUrl] = useState('');

  // Don't allow sharing until a preview is ready so we can get a decent screenshot.
  const previews = useStore(workbenchStore.previews);
  const anyPreviewReady = previews.some((preview) => preview.ready);

  // Form state
  const [isSharedDraft, setIsSharedDraft] = useState(false);

  // This button is always visible so these are generally available by the time
  // the user clicks the button.
  const chatId = useChatId();
  const sessionId = useSessionId();

  // private shared project info
  const currentShare = useQuery(api.socialShare.getCurrentSocialShare, {
    id: chatId,
    sessionId,
  });

  const createShare = useMutation(api.share.create);
  const socialShare = useMutation(api.socialShare.share);

  // Update form state when currentShare changes
  useEffect(() => {
    if (currentShare) {
      setIsSharedDraft(currentShare.isShared);

      // Set up share URL if we have a code
      if (currentShare.code) {
        setShareUrl(shareUrlForCode(currentShare.code));
      }
    }
  }, [currentShare]);

  const handleCreateSnapshot = async () => {
    try {
      setSnapshotStatus('loading');

      const result = await createShare({
        id: chatId,
        sessionId,
      });
      const { origin } = window.location;
      const url = `${origin}/create/${result.code}`;
      setSnapshotUrl(url);
      setSnapshotStatus('success');
    } catch (error) {
      toast.error('Failed to create snapshot. Please try again.');
      logger.error('Snapshot error:', error);
      setSnapshotStatus('idle');
    }
  };

  const handleShare = async (nextIsShared = isSharedDraft) => {
    try {
      setShareStatus('loading');

      await socialShare({
        sessionId,
        id: chatId,
        isShared: nextIsShared,
      });

      setShareStatus('success');
      toast.success('Sharing settings saved');
    } catch (error) {
      toast.error('Failed to update share settings. Please try again.');
      logger.error('Share error:', error);
      setShareStatus('idle');
    }
  };

  const copyToClipboard = (url: string) => {
    navigator.clipboard.writeText(url);
    toast.success('Link copied to clipboard!');
  };

  // Reset status when popover closes
  const handleOpenChange = async (open: boolean) => {
    setIsOpen(open);
    if (open && !currentShare) {
      // Auto-share on first open, when there is no share record yet.
      setShareStatus('loading');
      await handleShare(true);
    }
    if (open && !currentShare?.thumbnailUrl) {
      // Try to grab a screenshot each time the share menu is opened if there isn't one.
      try {
        const screenshot = await workbenchStore.requestAnyScreenshot(3000);
        if (screenshot) {
          await uploadThumbnail(screenshot, sessionId, chatId);
        }
      } catch (error) {
        // This will happen a lot at first: old projects don't response to screenshot requests.
        logger.error('Error uploading thumbnail:', error);
        captureException(error);
      }
    }
    if (!open) {
      // on close, clear any draft state
      setIsSharedDraft(currentShare ? currentShare.isShared : false);
      setSnapshotStatus('idle');
      setShareStatus('idle');
    }
  };

  const hasChanges = currentShare && currentShare.isShared !== isSharedDraft;

  const handleRequestCapture = useCallback(() => {
    return workbenchStore.requestAnyScreenshot();
  }, []);

  return (
    <>
      <Popover.Root open={isOpen} onOpenChange={handleOpenChange}>
        <Popover.Trigger asChild>
          <Button disabled={!anyPreviewReady} focused={isOpen} variant="neutral" size="xs">
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
              <div>
                <div className="space-y-4">
                  <label className="group flex cursor-pointer items-start gap-2">
                    <Checkbox
                      id="isShared"
                      checked={isSharedDraft}
                      onChange={(e: ChangeEvent<HTMLInputElement>) => setIsSharedDraft(e.target.checked)}
                    />
                    <span className="group-hover:text-content-primary block text-sm font-medium">Share project</span>
                  </label>

                  {/* Share link input and buttons, no label, right below checkbox */}
                  {currentShare?.isShared && (
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        readOnly
                        value={shareUrl}
                        className="text-content-primary flex-1 rounded-md border bg-bolt-elements-background-depth-2 px-3 py-1.5 text-sm"
                      />
                      <Button
                        variant="neutral"
                        size="xs"
                        onClick={() => copyToClipboard(shareUrl)}
                        tip="Copy link"
                        icon={<ClipboardIcon />}
                      />
                      <Button
                        variant="neutral"
                        size="xs"
                        onClick={() => window.open(shareUrl, '_blank', 'noopener,noreferrer')}
                        tip="Open in new tab"
                        icon={<ExternalLinkIcon />}
                      />
                    </div>
                  )}

                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Button variant="neutral" size="xs" onClick={() => setIsThumbnailModalOpen(true)}>
                        {currentShare?.thumbnailUrl ? (
                          <div className="relative size-4 overflow-hidden rounded shadow-[0_2px_4px_rgba(0,0,0,0.4)] ring-1 ring-black/10">
                            <img
                              src={currentShare.thumbnailUrl}
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
                    </div>

                    <Button
                      variant="neutral"
                      onClick={() => handleShare()}
                      disabled={shareStatus === 'loading' || !hasChanges}
                    >
                      {shareStatus === 'loading' ? (
                        <>
                          <Spinner className="size-4" />
                          <span>Saving...</span>
                        </>
                      ) : hasChanges ? (
                        'Save sharing settings'
                      ) : (
                        'Saved'
                      )}
                    </Button>
                  </div>
                </div>
              </div>

              <div className="space-y-4 border-t pt-4">
                <details className="group">
                  <summary className="flex cursor-pointer select-none items-center justify-between">
                    <div className="flex items-center gap-2">
                      <ChevronRightIcon className="size-4 transition-transform group-open:rotate-90" />
                      <span className="text-content-secondary group-hover:text-content-primary text-sm">
                        More ways to share
                      </span>
                    </div>
                  </summary>
                  <div className="mt-4 space-y-4">
                    <div className="flex items-center justify-start gap-2">
                      <Button variant="neutral" onClick={handleCreateSnapshot}>
                        Create Point-In-Time Snapshot
                      </Button>
                      <Tooltip tip="Create a link to a specific version of your project that others can clone, including all chat history but without database contents. This can be useful for support tickets.">
                        <InfoCircledIcon className="size-4" />
                      </Tooltip>
                    </div>

                    {snapshotStatus === 'loading' && (
                      <div className="flex flex-col items-center justify-center py-4">
                        <Spinner />
                        <p className="text-content-secondary text-sm">Creating snapshot…</p>
                      </div>
                    )}

                    {snapshotStatus === 'success' && snapshotUrl && (
                      <div className="space-y-2">
                        <p className="text-content-secondary text-sm">Snapshot link:</p>
                        <div className="flex items-center gap-2">
                          <input
                            type="text"
                            readOnly
                            value={snapshotUrl}
                            className="text-content-primary flex-1 rounded-md border bg-bolt-elements-background-depth-2 px-3 py-1.5 text-sm"
                          />
                          <Button
                            variant="neutral"
                            size="xs"
                            onClick={() => copyToClipboard(snapshotUrl)}
                            tip="Copy link"
                            icon={<ClipboardIcon />}
                          />
                          <Button
                            variant="neutral"
                            size="xs"
                            onClick={() => window.open(snapshotUrl, '_blank', 'noopener,noreferrer')}
                            tip="Open in new tab"
                            icon={<ExternalLinkIcon />}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                </details>
              </div>
            </div>

            <Popover.Arrow className="fill-border-transparent" />
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>

      <Dialog.Root open={isThumbnailModalOpen} onOpenChange={setIsThumbnailModalOpen}>
        <ThumbnailChooser
          isOpen={isThumbnailModalOpen}
          onOpenChange={setIsThumbnailModalOpen}
          onRequestCapture={handleRequestCapture}
        />
      </Dialog.Root>
    </>
  );
}
