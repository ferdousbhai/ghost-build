import { atom } from 'nanostores';
import { getKnownUrlId, setKnownInitialId, setKnownUrlId } from '~/lib/stores/chatId';
import { executeDataOperation } from '~/lib/cloudflare/client';
import { api } from '~/lib/cloudflare/data-api';
import { description as descriptionStore } from '~/lib/stores/description';
import { compressWithLz4 } from '~/lib/compression';
import { waitForStoreCondition } from '~/lib/stores/waitForStore';
import { stripMetadata } from '~/components/chat/UserMessage';
import { createdAtMillis, messageText, type GhostbuildMessage } from 'ghostbuild-agent/ai-compat';

const textEncoder = new TextEncoder();

export type CompleteMessageInfo = {
  messageIndex: number;
  partIndex: number;
  hasNextPart: boolean;
  allMessages: GhostbuildMessage[];
};

export type SerializedMessage = Omit<GhostbuildMessage, 'createdAt' | 'content'> & {
  createdAt: number | undefined;
  content?: string;
};

export const lastCompleteMessageInfoStore = atom<CompleteMessageInfo | null>(null);

export function prepareMessageHistory(args: {
  chatId: string;
  sessionId: string;
  completeMessageInfo: CompleteMessageInfo;
  persistedMessageInfo: { messageIndex: number; partIndex: number };
  subchatIndex: number;
}): {
  url: URL;
  update: {
    compressed: Uint8Array;
    urlHintAndDescription: { urlHint: string; description: string } | undefined;
    messageIndex: number;
    partIndex: number;
    firstMessage: string | undefined;
  } | null;
} {
  const { chatId, sessionId, completeMessageInfo, persistedMessageInfo } = args;
  const { messageIndex, partIndex, allMessages } = completeMessageInfo;
  const url = new URL('/api/chats/store', window.location.origin);

  url.searchParams.set('chatId', chatId);
  url.searchParams.set('sessionId', sessionId);
  url.searchParams.set('lastMessageRank', messageIndex.toString());
  url.searchParams.set('partIndex', partIndex.toString());
  url.searchParams.set('lastSubchatIndex', args.subchatIndex.toString());
  const firstMessage = allMessages.length > 0 ? stripMetadata(messageText(allMessages[0])) : undefined;
  if (messageIndex === persistedMessageInfo.messageIndex && partIndex === persistedMessageInfo.partIndex) {
    // No changes
    return { url, update: null };
  }

  const urlHintAndDescription = getKnownUrlId() === undefined ? extractUrlHintAndDescription(allMessages) : undefined;
  const compressed = compressMessages(allMessages, messageIndex, partIndex);
  return { url, update: { compressed, urlHintAndDescription, messageIndex, partIndex, firstMessage } };
}

export async function handleUrlHintAndDescription(
  chatId: string,
  sessionId: string,
  urlHint: string,
  description: string,
) {
  if (getKnownUrlId() === undefined) {
    const { urlId, initialId } = await executeDataOperation(api.messages.setUrlId, {
      sessionId,
      chatId,
      urlHint,
      description,
    });
    descriptionStore.set(description);
    setKnownUrlId(urlId);
    setKnownInitialId(initialId);
  }
}

export function waitForNewMessages(
  messageIndex: number,
  partIndex: number,
  alertOnNextPartStart: boolean,
  signal?: AbortSignal,
) {
  const hasNewMessages = (lastCompleteMessageInfo: CompleteMessageInfo | null) =>
    lastCompleteMessageInfo !== null &&
    (lastCompleteMessageInfo.messageIndex !== messageIndex ||
      lastCompleteMessageInfo.partIndex !== partIndex ||
      (alertOnNextPartStart && lastCompleteMessageInfo.hasNextPart));

  return waitForStoreCondition(lastCompleteMessageInfoStore, hasNewMessages, { signal });
}

function extractUrlHintAndDescription(messages: GhostbuildMessage[]) {
  /*
   * Assign a URL hint and description based on the first artifact registered.
   */
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      if (part.type === 'text') {
        const content = part.text;
        // Don't match on "Relevant Files" messages
        const match = content.match(/<boltArtifact id="([^"]+)" title="(?!Relevant Files)([^"]+)"/);
        if (match) {
          return { urlHint: match[1], description: match[2] };
        }
      }
    }
  }
  return undefined;
}

export function serializeMessageForStorage(message: GhostbuildMessage) {
  // `content` + `toolInvocations` are duplicated in `parts`; annotations are legacy metadata.
  // We should avoid storing them since we already store `parts`.
  const {
    content: _content,
    toolInvocations: _toolInvocations,
    annotations: _annotations,
    parts,
    ...rest
  } = message as GhostbuildMessage & { annotations?: unknown[]; toolInvocations?: unknown[] };

  return {
    ...rest,
    parts,
    createdAt: createdAtMillis(message),
  };
}

function compressMessages(messages: GhostbuildMessage[], lastMessageRank: number, partIndex: number): Uint8Array {
  const slicedMessages = messages.slice(0, lastMessageRank + 1);
  const lastMessage = slicedMessages.at(-1);
  if (lastMessage) {
    slicedMessages[slicedMessages.length - 1] = {
      ...lastMessage,
      parts: lastMessage.parts?.slice(0, partIndex + 1),
    };
  }
  const serialized = slicedMessages.map(serializeMessageForStorage);
  const uint8Array = textEncoder.encode(JSON.stringify(serialized));
  return compressWithLz4(uint8Array);
}
