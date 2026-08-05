import { useStore } from '@nanostores/react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import type { TranscriptCheckpoint, TranscriptIdentity } from 'ghostbuild-agent/transcript';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { useCachedChatTranscript } from '~/lib/cloudflare/chat-transcript-db';
import { setKnownInitialId } from '~/lib/stores/chatId';
import { description } from '~/lib/stores/description';
import { useUserIdOrNullOrLoading } from '~/lib/stores/userId';
import { subchatIndexStore } from '~/lib/stores/subchats';
import type { SerializedMessage } from './messages';

const logger = createScopedLogger('InitialMessages');

interface InitialMessages {
  loadedChatId: string;
  deserialized: GhostbuildMessage[];
  loadedSubchatIndex: number;
  transcript: TranscriptIdentity;
  checkpoint: TranscriptCheckpoint | null;
}

type TranscriptSelection = {
  scope: string;
  subchatIndex?: number;
  loadedSubchatIndex?: number;
};

export function useInitialMessages(chatId: string | undefined):
  | InitialMessages
  | null // not found
  | undefined {
  const userId = useUserIdOrNullOrLoading();
  const subchatIndex = useStore(subchatIndexStore);
  const scope = chatId && userId ? `${userId}:${chatId}` : undefined;
  const [selection, setSelection] = useState<TranscriptSelection>();
  const activeSelection = selection?.scope === scope ? selection : undefined;
  const cached = useCachedChatTranscript(
    userId,
    chatId && activeSelection
      ? {
          chatId,
          ...(activeSelection.subchatIndex === undefined ? {} : { subchatIndex: activeSelection.subchatIndex }),
        }
      : undefined,
  );

  useEffect(() => {
    setSelection(scope ? { scope } : undefined);
  }, [scope]);

  useEffect(() => {
    const transcript = cached.transcript;
    if (!activeSelection || transcript?.status !== 'ready') {
      return;
    }
    if (activeSelection.subchatIndex !== undefined && transcript.loadedSubchatIndex !== activeSelection.subchatIndex) {
      return;
    }
    if (activeSelection.loadedSubchatIndex !== transcript.loadedSubchatIndex) {
      if (subchatIndexStore.get() !== transcript.loadedSubchatIndex) {
        subchatIndexStore.set(transcript.loadedSubchatIndex);
      }
      setSelection({
        ...activeSelection,
        loadedSubchatIndex: transcript.loadedSubchatIndex,
      });
      return;
    }
    if (subchatIndex !== undefined && subchatIndex !== transcript.loadedSubchatIndex) {
      setSelection({
        scope: activeSelection.scope,
        subchatIndex,
      });
    }
  }, [activeSelection, cached.transcript, subchatIndex]);

  useEffect(() => {
    const transcript = cached.transcript;
    if (transcript?.status !== 'ready') {
      return;
    }
    setKnownInitialId(transcript.initialId);
    description.set(transcript.description);
  }, [cached.transcript]);

  useEffect(() => {
    if (!cached.error) {
      return;
    }
    toast.error('Failed to refresh chat messages from storage. Try reloading the page.');
    logger.error('Error refreshing initial messages:', cached.error);
  }, [cached.error]);

  const initialMessages = useMemo<InitialMessages | null | undefined>(() => {
    const transcript = cached.transcript;
    if (!chatId || !userId || !activeSelection || cached.isLoading || transcript === undefined) {
      return undefined;
    }
    if (transcript.status === 'missing') {
      return null;
    }
    const deserialized = transcript.messages.map(deserializeMessageFromStorage);
    return {
      loadedChatId: transcript.loadedChatId,
      deserialized,
      loadedSubchatIndex: transcript.loadedSubchatIndex,
      transcript: transcript.transcript,
      checkpoint: transcript.checkpoint,
    };
  }, [activeSelection, cached.isLoading, cached.transcript, chatId, userId]);

  if (initialMessages && subchatIndex !== undefined && initialMessages.loadedSubchatIndex !== subchatIndex) {
    return undefined;
  }
  return initialMessages;
}

function deserializeMessageFromStorage(message: SerializedMessage): GhostbuildMessage {
  return {
    ...message,
    createdAt: message.createdAt === undefined ? undefined : new Date(message.createdAt),
  };
}
