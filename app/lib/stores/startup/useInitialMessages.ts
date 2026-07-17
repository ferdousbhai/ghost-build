import { useState, useEffect } from 'react';
import { executeDataOperation } from '~/lib/cloudflare/client';
import { useSessionIdOrNullOrLoading } from '~/lib/stores/sessionId';
import { api } from '~/lib/cloudflare/data-api';
import { setKnownInitialId, setKnownUrlId } from '~/lib/stores/chatId';
import { description } from '~/lib/stores/description';
import { toast } from 'sonner';
import { decompressWithLz4 } from '~/lib/compression';
import { subchatIndexStore } from '~/lib/stores/subchats';
import { useStore } from '@nanostores/react';
import {
  getToolInvocation,
  isToolInvocationInProgress,
  messageText,
  type GhostbuildMessage,
} from 'ghostbuild-agent/ai-compat';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import type { SerializedMessage } from './messages';
import {
  transcriptCheckpointSchema,
  transcriptIdentitiesEqual,
  transcriptIdentitySchema,
  type TranscriptCheckpoint,
  type TranscriptIdentity,
} from 'ghostbuild-agent/transcript';

const logger = createScopedLogger('InitialMessages');
const textDecoder = new TextDecoder();

interface InitialMessages {
  loadedChatId: string;
  deserialized: GhostbuildMessage[];
  loadedSubchatIndex: number;
  transcript: TranscriptIdentity;
  checkpoint: TranscriptCheckpoint | null;
  seedTranscript: boolean;
}

export function useInitialMessages(chatId: string | undefined):
  | InitialMessages
  | null // not found
  | undefined {
  const [initialMessages, setInitialMessages] = useState<InitialMessages | null | undefined>();
  const subchatIndex = useStore(subchatIndexStore);
  const sessionId = useSessionIdOrNullOrLoading();

  useEffect(() => {
    if (!chatId || !sessionId) {
      setInitialMessages(undefined);
      return undefined;
    }

    const controller = new AbortController();
    setInitialMessages(undefined);
    const loadInitialMessages = async () => {
      try {
        controller.signal.throwIfAborted();
        const chatInfo = await executeDataOperation(api.messages.get, {
          id: chatId,
          sessionId,
          ...(subchatIndex === undefined ? {} : { subchatIndex }),
        });
        controller.signal.throwIfAborted();
        if (chatInfo === null) {
          setInitialMessages(null);
          return;
        }
        if (subchatIndex === undefined) {
          subchatIndexStore.set(chatInfo.subchatIndex);
          // Exit early to let the effect run again with the new subchatIndex
          return;
        }

        setKnownInitialId(chatInfo.initialId);
        if (chatInfo.urlId) {
          setKnownUrlId(chatInfo.urlId);
        }
        description.set(chatInfo.description);
        const initialMessagesResponse = await fetch('/api/chats/messages', {
          method: 'POST',
          body: JSON.stringify({
            chatId,
            sessionId,
            subchatIndex,
          }),
          signal: controller.signal,
        });
        if (!initialMessagesResponse.ok) {
          throw new Error('Failed to fetch initial messages');
        }
        const responseTranscript =
          transcriptIdentityFromHeaders(initialMessagesResponse.headers) ?? chatInfo.transcript;

        if (initialMessagesResponse.status === 204) {
          setInitialMessages({
            loadedChatId: chatInfo.urlId ?? chatInfo.initialId,
            deserialized: [],
            loadedSubchatIndex: subchatIndex,
            transcript: responseTranscript,
            checkpoint: null,
            seedTranscript: false,
          });
          return;
        }
        const history = initialMessagesResponse.headers.get('content-type')?.includes('application/json')
          ? parseMessageHistory(await initialMessagesResponse.json())
          : decompressMessages(new Uint8Array(await initialMessagesResponse.arrayBuffer()));
        const initialMessages = history.messages;

        // Transform messages to convert partial-call states to failed states
        const transformedMessages = initialMessages.map((message) => {
          if (!message.parts) {
            return message;
          }

          const updatedParts = message.parts.map((part) => {
            if (part.type === 'tool-invocation') {
              // Persisted in-flight tool calls came from an interrupted stream.
              const invocation = getToolInvocation(part);
              if (invocation && isToolInvocationInProgress(invocation)) {
                return {
                  ...part,
                  toolInvocation: {
                    ...invocation,
                    state: 'result' as const,
                    result: 'Error: Tool call was interrupted',
                  },
                };
              }
            }
            return part;
          });

          return {
            ...message,
            parts: updatedParts,
          };
        });

        const deserializedMessages = transformedMessages.map(deserializeMessageFromStorage);
        controller.signal.throwIfAborted();
        setInitialMessages({
          loadedChatId: chatInfo.urlId ?? chatInfo.initialId,
          deserialized: deserializedMessages,
          loadedSubchatIndex: subchatIndex,
          transcript: responseTranscript,
          checkpoint:
            history.checkpoint && transcriptIdentitiesEqual(history.checkpoint, responseTranscript)
              ? history.checkpoint
              : null,
          seedTranscript:
            initialMessagesResponse.headers.get('X-Ghostbuild-Transcript-Source') === 'materialized' &&
            deserializedMessages.length > 0,
        });
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        toast.error('Failed to load chat messages from storage. Try reloading the page.');
        logger.error('Error fetching initial messages:', error);
      }
    };
    void loadInitialMessages();
    return () => controller.abort();
  }, [chatId, sessionId, subchatIndex]);

  if (initialMessages && subchatIndex !== undefined && initialMessages.loadedSubchatIndex !== subchatIndex) {
    return undefined;
  }

  return initialMessages;
}

function transcriptIdentityFromHeaders(headers: Headers): TranscriptIdentity | null {
  const generation = headers.get('X-Ghostbuild-Transcript-Generation');
  const subchatIndex = headers.get('X-Ghostbuild-Transcript-Subchat');
  const result = transcriptIdentitySchema.safeParse({
    agentName: headers.get('X-Ghostbuild-Transcript-Agent'),
    generation: generation === null ? Number.NaN : Number(generation),
    subchatIndex: subchatIndex === null ? Number.NaN : Number(subchatIndex),
  });
  return result.success ? result.data : null;
}

function deserializeMessageFromStorage(message: SerializedMessage): GhostbuildMessage {
  const content = messageText(message as GhostbuildMessage);

  return {
    ...message,
    createdAt: message.createdAt ? new Date(message.createdAt) : undefined,
    content,
  };
}

function decompressMessages(compressed: Uint8Array): {
  messages: SerializedMessage[];
  checkpoint: TranscriptCheckpoint | null;
} {
  const decompressed = decompressWithLz4(compressed);
  const deserialized = JSON.parse(textDecoder.decode(decompressed));
  return parseMessageHistory(deserialized);
}

function parseMessageHistory(deserialized: unknown): {
  messages: SerializedMessage[];
  checkpoint: TranscriptCheckpoint | null;
} {
  if (!Array.isArray(deserialized)) {
    const history = deserialized as Record<string, unknown> | null;
    if (history !== null && history.version === 2 && Array.isArray(history.messages)) {
      const checkpoint = transcriptCheckpointSchema.parse(history.transcript);
      return { messages: history.messages as SerializedMessage[], checkpoint };
    }
    throw new Error('Unexpected state -- decompressed data is not a message history');
  }
  return { messages: deserialized as SerializedMessage[], checkpoint: null };
}
