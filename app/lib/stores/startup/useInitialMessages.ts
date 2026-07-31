import { useStore } from '@nanostores/react';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  getToolInvocation,
  isToolInvocationInProgress,
  messageText,
  type GhostbuildMessage,
} from 'ghostbuild-agent/ai-compat';
import type { TranscriptCheckpoint, TranscriptIdentity } from 'ghostbuild-agent/transcript';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { useCachedChatTranscript } from '~/lib/cloudflare/chat-transcript-db';
import { setKnownInitialId, setKnownUrlId } from '~/lib/stores/chatId';
import { description } from '~/lib/stores/description';
import { useSessionIdOrNullOrLoading } from '~/lib/stores/sessionId';
import { subchatIndexStore } from '~/lib/stores/subchats';
import type { SerializedMessage } from './messages';

const logger = createScopedLogger('InitialMessages');

interface InitialMessages {
  loadedChatId: string;
  urlId?: string;
  deserialized: GhostbuildMessage[];
  loadedSubchatIndex: number;
  transcript: TranscriptIdentity;
  checkpoint: TranscriptCheckpoint | null;
  seedTranscript: boolean;
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
  const sessionId = useSessionIdOrNullOrLoading();
  const subchatIndex = useStore(subchatIndexStore);
  const scope = chatId && sessionId ? `${sessionId}:${chatId}` : undefined;
  const [selection, setSelection] = useState<TranscriptSelection>();
  const activeSelection = selection?.scope === scope ? selection : undefined;
  const cached = useCachedChatTranscript(
    sessionId,
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
    if (transcript.urlId) {
      setKnownUrlId(transcript.urlId);
    }
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
    if (!chatId || !sessionId || !activeSelection || cached.isLoading || transcript === undefined) {
      return undefined;
    }
    if (transcript.status === 'missing') {
      return null;
    }
    const deserialized = transcript.messages.map(markInterruptedToolCalls).map(deserializeMessageFromStorage);
    return {
      loadedChatId: transcript.loadedChatId,
      ...(transcript.urlId ? { urlId: transcript.urlId } : {}),
      deserialized,
      loadedSubchatIndex: transcript.loadedSubchatIndex,
      transcript: transcript.transcript,
      checkpoint: transcript.checkpoint,
      seedTranscript: transcript.seedTranscript,
    };
  }, [activeSelection, cached.isLoading, cached.transcript, chatId, sessionId]);

  if (initialMessages && subchatIndex !== undefined && initialMessages.loadedSubchatIndex !== subchatIndex) {
    return undefined;
  }
  return initialMessages;
}

function markInterruptedToolCalls(message: SerializedMessage): SerializedMessage {
  if (!message.parts) {
    return message;
  }
  return {
    ...message,
    parts: message.parts.map((part) => {
      if (part.type !== 'tool-invocation') {
        return part;
      }
      const invocation = getToolInvocation(part);
      if (!invocation || !isToolInvocationInProgress(invocation)) {
        return part;
      }
      return {
        ...part,
        toolInvocation: {
          ...invocation,
          state: 'result' as const,
          result: 'Error: Tool call was interrupted',
        },
      };
    }),
  };
}

function deserializeMessageFromStorage(message: SerializedMessage): GhostbuildMessage {
  const content = messageText(message as GhostbuildMessage);
  return {
    ...message,
    createdAt: message.createdAt ? new Date(message.createdAt) : undefined,
    content,
  };
}
