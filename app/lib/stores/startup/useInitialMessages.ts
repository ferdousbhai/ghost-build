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

const logger = createScopedLogger('InitialMessages');
const textDecoder = new TextDecoder();

interface InitialMessages {
  loadedChatId: string;
  deserialized: GhostbuildMessage[];
  loadedSubchatIndex: number;
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

        if (initialMessagesResponse.status === 204) {
          setInitialMessages({
            loadedChatId: chatInfo.urlId ?? chatInfo.initialId,
            deserialized: [],
            loadedSubchatIndex: subchatIndex,
          });
          return;
        }
        const content = await initialMessagesResponse.arrayBuffer();
        const initialMessages = decompressMessages(new Uint8Array(content));

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
        });
        description.set(chatInfo.description);
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

  return initialMessages;
}

function deserializeMessageFromStorage(message: SerializedMessage): GhostbuildMessage {
  const content = messageText(message as GhostbuildMessage);

  return {
    ...message,
    createdAt: message.createdAt ? new Date(message.createdAt) : undefined,
    content,
  };
}

function decompressMessages(compressed: Uint8Array): SerializedMessage[] {
  const decompressed = decompressWithLz4(compressed);
  const deserialized = JSON.parse(textDecoder.decode(decompressed));
  if (!Array.isArray(deserialized)) {
    throw new Error('Unexpected state -- decompressed data is not an array');
  }
  return deserialized;
}
