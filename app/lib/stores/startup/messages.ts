import { atom } from 'nanostores';
import { waitForStoreCondition } from '~/lib/stores/waitForStore';
import { createdAtMillis, messageText, type GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import {
  stripTranscriptBaseMetadata,
  transcriptCheckpointsEqual,
  type TranscriptCheckpoint,
} from 'ghostbuild-agent/transcript';

export type CompleteMessageInfo = {
  messageIndex: number;
  partIndex: number;
  hasNextPart: boolean;
  allMessages: GhostbuildMessage[];
  transcriptCheckpoint: TranscriptCheckpoint | null;
};

export type SerializedMessage = Omit<GhostbuildMessage, 'createdAt'> & {
  createdAt: number | undefined;
};

export const lastCompleteMessageInfoStore = atom<CompleteMessageInfo | null>(null);

export function prepareMessageHistory(args: {
  chatId: string;
  sessionId: string;
  completeMessageInfo: CompleteMessageInfo;
  persistedMessageInfo: { messageIndex: number; partIndex: number };
  persistedTranscriptCheckpoint: TranscriptCheckpoint | null;
  subchatIndex: number;
}): {
  url: URL;
  update: {
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
  const firstMessage = allMessages.length > 0 ? messageText(allMessages[0]) : undefined;
  if (!completeMessageInfo.transcriptCheckpoint) {
    return { url, update: null };
  }
  const checkpoint = completeMessageInfo.transcriptCheckpoint;
  url.searchParams.set('transcriptAgentName', checkpoint.agentName);
  url.searchParams.set('transcriptGeneration', checkpoint.generation.toString());
  url.searchParams.set('transcriptRevision', checkpoint.revision.toString());
  url.searchParams.set('transcriptDigest', checkpoint.digest);
  url.searchParams.set('transcriptMessageCount', checkpoint.messageCount.toString());
  if (
    messageIndex === persistedMessageInfo.messageIndex &&
    partIndex === persistedMessageInfo.partIndex &&
    transcriptCheckpointsEqual(checkpoint, args.persistedTranscriptCheckpoint)
  ) {
    // No changes
    return { url, update: null };
  }

  return { url, update: { messageIndex, partIndex, firstMessage } };
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

export function serializeMessageForStorage(message: GhostbuildMessage) {
  const { parts, ...rest } = stripTranscriptBaseMetadata(message);

  return {
    ...rest,
    parts,
    createdAt: createdAtMillis(message),
  };
}

export function serializeCompleteMessages(
  messages: GhostbuildMessage[],
  lastMessageRank: number,
  partIndex: number,
): SerializedMessage[] {
  const slicedMessages = messages.slice(0, lastMessageRank + 1);
  const lastMessage = slicedMessages.at(-1);
  if (lastMessage) {
    slicedMessages[slicedMessages.length - 1] = {
      ...lastMessage,
      parts: lastMessage.parts?.slice(0, partIndex + 1),
    };
  }
  return slicedMessages.map(serializeMessageForStorage);
}
