import { useStore } from '@nanostores/react';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { toast } from 'sonner';
import { uploadThumbnail } from '~/components/workbench/thumbnail-upload.client';
import { api } from '~/lib/cloudflare/data-api';
import type { CurrentSocialShare } from '~/lib/cloudflare/data-api';
import { useMutation, useQuery } from '~/lib/cloudflare/data-hooks';
import { useChatId } from '~/lib/stores/chatId';
import { useSessionId } from '~/lib/stores/sessionId';
import { workbenchStore } from '~/lib/stores/workbench.client';
import { captureException } from '~/lib/telemetry.client';

const logger = createScopedLogger('ShareProject');
type OperationStatus = 'idle' | 'loading' | 'success';
type OptimisticShare = CurrentSocialShare & { chatId: string };

export function useShareProject() {
  const [isOpen, setIsOpen] = useState(false);
  const [isThumbnailModalOpen, setIsThumbnailModalOpen] = useState(false);
  const [snapshotStatus, setSnapshotStatus] = useState<OperationStatus>('idle');
  const [shareStatus, setShareStatus] = useState<OperationStatus>('idle');
  const [snapshotUrl, setSnapshotUrl] = useState('');
  const [isSharedDraft, setIsSharedDraft] = useState(false);
  const [optimisticShare, setOptimisticShare] = useState<OptimisticShare | null>(null);
  const previews = useStore(workbenchStore.previews);
  const chatId = useChatId();
  const activeChatIdRef = useRef(chatId);
  const previousChatIdRef = useRef(chatId);
  activeChatIdRef.current = chatId;
  const sessionId = useSessionId();
  const queriedShare = useQuery(api.socialShare.getCurrentSocialShare, { id: chatId, sessionId });
  const currentShare = optimisticShare?.chatId === chatId ? optimisticShare : queriedShare;
  const shareUrl = useMemo(() => (currentShare?.code ? shareUrlForCode(currentShare.code) : ''), [currentShare?.code]);
  const createShare = useMutation(api.share.create);
  const socialShare = useMutation(api.socialShare.share);
  const queryClient = useQueryClient();

  useEffect(() => {
    if (previousChatIdRef.current === chatId) {
      return;
    }
    previousChatIdRef.current = chatId;
    setIsOpen(false);
    setIsThumbnailModalOpen(false);
    setIsSharedDraft(false);
    setOptimisticShare(null);
    setSnapshotUrl('');
    setSnapshotStatus('idle');
    setShareStatus('idle');
  }, [chatId]);

  useEffect(() => {
    if (!queriedShare) {
      return;
    }
    if (optimisticShare?.chatId !== chatId) {
      setOptimisticShare({ ...queriedShare, chatId });
      if (!isOpen) {
        setIsSharedDraft(queriedShare.isShared);
      }
      return;
    }
    if (queriedShare.thumbnailUrl && queriedShare.thumbnailUrl !== optimisticShare.thumbnailUrl) {
      setOptimisticShare({ ...optimisticShare, thumbnailUrl: queriedShare.thumbnailUrl });
    }
  }, [chatId, isOpen, optimisticShare, queriedShare]);

  const saveSharing = useCallback(
    async (nextIsShared = isSharedDraft) => {
      try {
        setShareStatus('loading');
        const code = await socialShare({ sessionId, id: chatId, isShared: nextIsShared });
        if (activeChatIdRef.current !== chatId) {
          return true;
        }
        setOptimisticShare((existing) => {
          const existingForChat = existing?.chatId === chatId ? existing : null;
          return {
            chatId,
            code,
            isShared: nextIsShared,
            thumbnailUrl: existingForChat?.thumbnailUrl ?? queriedShare?.thumbnailUrl ?? null,
          };
        });
        setIsSharedDraft(nextIsShared);
        setShareStatus('success');
        void queryClient
          .invalidateQueries({ queryKey: ['ghostbuild-data', api.socialShare.getCurrentSocialShare] })
          .catch((error) => logger.warn('Failed to refresh sharing state', error));
        toast.success('Sharing settings saved');
        return true;
      } catch (error) {
        if (activeChatIdRef.current !== chatId) {
          return false;
        }
        toast.error('Failed to update share settings. Please try again.');
        logger.error('Share error:', error);
        setShareStatus('idle');
        return false;
      }
    },
    [chatId, isSharedDraft, queriedShare?.thumbnailUrl, queryClient, sessionId, socialShare],
  );

  const createSnapshot = useCallback(async () => {
    try {
      setSnapshotStatus('loading');
      const result = await createShare({ id: chatId, sessionId });
      if (activeChatIdRef.current !== chatId) {
        return;
      }
      setSnapshotUrl(`${window.location.origin}/create/${result.code}`);
      setSnapshotStatus('success');
    } catch (error) {
      if (activeChatIdRef.current !== chatId) {
        return;
      }
      toast.error('Failed to create snapshot. Please try again.');
      logger.error('Snapshot error:', error);
      setSnapshotStatus('idle');
    }
  }, [chatId, createShare, sessionId]);

  const handleOpenChange = useCallback(
    async (open: boolean) => {
      setIsOpen(open);
      if (!open) {
        setIsSharedDraft(currentShare?.isShared ?? false);
        setSnapshotStatus('idle');
        setShareStatus('idle');
        return;
      }

      const initializeSharing = currentShare ? Promise.resolve(true) : saveSharing(true);
      if (!currentShare?.thumbnailUrl) {
        try {
          const [screenshot, sharingReady] = await Promise.all([
            workbenchStore.requestAnyScreenshot(3000),
            initializeSharing,
          ]);
          if (!sharingReady) {
            return;
          }
          await uploadThumbnail(screenshot, sessionId, chatId);
          if (activeChatIdRef.current !== chatId) {
            return;
          }
          setOptimisticShare((existing) =>
            existing?.chatId === chatId ? { ...existing, thumbnailUrl: screenshot } : existing,
          );
          void queryClient
            .invalidateQueries({ queryKey: ['ghostbuild-data', api.socialShare.getCurrentSocialShare] })
            .catch((error) => logger.warn('Failed to refresh sharing thumbnail', error));
        } catch (error) {
          if (activeChatIdRef.current !== chatId) {
            return;
          }
          logger.error('Error uploading thumbnail:', error);
          captureException(error);
        }
        return;
      }
      await initializeSharing;
    },
    [chatId, currentShare, queryClient, saveSharing, sessionId],
  );

  return {
    anyPreviewReady: previews.some((preview) => preview.ready),
    copyToClipboard: async (url: string) => {
      try {
        await navigator.clipboard.writeText(url);
        toast.success('Link copied to clipboard!');
      } catch (error) {
        logger.error('Failed to copy share link:', error);
        toast.error('Failed to copy link');
      }
    },
    createSnapshot,
    currentShare,
    handleOpenChange,
    hasChanges: Boolean(currentShare && currentShare.isShared !== isSharedDraft),
    isOpen,
    isSharedDraft,
    isThumbnailModalOpen,
    requestCapture: () => workbenchStore.requestAnyScreenshot(),
    saveSharing,
    setIsSharedDraft,
    setIsThumbnailModalOpen,
    shareStatus,
    shareUrl,
    snapshotStatus,
    snapshotUrl,
  };
}

function shareUrlForCode(code: string): string {
  const { origin } = window.location;
  return origin === 'https://ghostbuild.dev' ? `https://ghostbuild.dev/share/${code}` : `${origin}/share/${code}`;
}
