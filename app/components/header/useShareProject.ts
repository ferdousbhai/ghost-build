import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { toast } from 'sonner';
import { api } from '~/lib/cloudflare/data-api';
import type { CurrentSocialShare } from '~/lib/cloudflare/data-api';
import { useMutation, useQuery } from '~/lib/cloudflare/data-hooks';
import { useChatId } from '~/lib/stores/chatId';
import { useSessionId } from '~/lib/stores/sessionId';

const logger = createScopedLogger('ShareProject');
type OperationStatus = 'idle' | 'loading' | 'success';
type OptimisticShare = CurrentSocialShare & { chatId: string };

export function useShareProject() {
  const [isOpen, setIsOpen] = useState(false);
  const [isThumbnailModalOpen, setIsThumbnailModalOpen] = useState(false);
  const [shareStatus, setShareStatus] = useState<OperationStatus>('idle');
  const [isSharedDraft, setIsSharedDraft] = useState(false);
  const [optimisticShare, setOptimisticShare] = useState<OptimisticShare | null>(null);
  const chatId = useChatId();
  const activeChatIdRef = useRef(chatId);
  const previousChatIdRef = useRef(chatId);
  activeChatIdRef.current = chatId;
  const sessionId = useSessionId();
  const queriedShare = useQuery(api.socialShare.getCurrentSocialShare, { id: chatId, sessionId });
  const currentShare = optimisticShare?.chatId === chatId ? optimisticShare : queriedShare;
  const shareUrl = useMemo(() => (currentShare?.code ? shareUrlForCode(currentShare.code) : ''), [currentShare?.code]);
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

  const persistSharing = useCallback(
    async (nextIsShared: boolean, showSuccessToast: boolean) => {
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
        if (showSuccessToast) {
          toast.success('Sharing settings saved');
        }
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
    [chatId, queriedShare?.thumbnailUrl, queryClient, sessionId, socialShare],
  );

  const saveSharing = useCallback(
    (nextIsShared = isSharedDraft) => persistSharing(nextIsShared, true),
    [isSharedDraft, persistSharing],
  );

  const handleOpenChange = useCallback(
    async (open: boolean) => {
      if (open && currentShare === undefined) {
        return;
      }
      setIsOpen(open);
      if (!open) {
        setIsSharedDraft(currentShare?.isShared ?? false);
        setShareStatus('idle');
        return;
      }

      // A share record is needed before uploading a thumbnail, but opening the
      // settings popover must not publish the project. Publication remains an
      // explicit checkbox + save action.
      const initializeSharing = currentShare ? Promise.resolve(true) : persistSharing(false, false);
      await initializeSharing;
    },
    [currentShare, persistSharing],
  );

  return {
    copyToClipboard: async (url: string) => {
      try {
        await navigator.clipboard.writeText(url);
        toast.success('Link copied to clipboard!');
      } catch (error) {
        logger.error('Failed to copy share link:', error);
        toast.error('Failed to copy link');
      }
    },
    currentShare,
    handleOpenChange,
    hasChanges: Boolean(currentShare && currentShare.isShared !== isSharedDraft),
    isOpen,
    isSharedDraft,
    isThumbnailModalOpen,
    saveSharing,
    sharingReady: currentShare !== undefined,
    setIsSharedDraft,
    setIsThumbnailModalOpen,
    shareStatus,
    shareUrl,
  };
}

function shareUrlForCode(code: string): string {
  const { origin } = window.location;
  return origin === 'https://ghostbuild.dev' ? `https://ghostbuild.dev/share/${code}` : `${origin}/share/${code}`;
}
