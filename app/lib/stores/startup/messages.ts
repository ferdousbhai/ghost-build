import { atom } from 'nanostores';
import { waitForStoreCondition } from '~/lib/stores/waitForStore';
import { createdAtMillis, type GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import {
  stripTranscriptBaseMetadata,
  transcriptCheckpointsEqual,
  type TranscriptCheckpoint,
} from 'ghostbuild-agent/transcript';

export type CompleteMessageInfo = {
  accountId: string;
  chatId: string;
  subchatIndex: number;
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

type PreparedMessageHistory = {
  searchParams: URLSearchParams;
  /** The checkpoint position this request would advance to, or `null` when nothing changed. */
  update: { messageIndex: number; partIndex: number } | null;
};

export function prepareMessageHistory(args: {
  chatId: string;
  sessionId: string;
  completeMessageInfo: CompleteMessageInfo;
  persistedMessageInfo: { messageIndex: number; partIndex: number };
  persistedTranscriptCheckpoint: TranscriptCheckpoint | null;
  subchatIndex: number;
}): PreparedMessageHistory {
  const { chatId, sessionId, completeMessageInfo, persistedMessageInfo } = args;
  const { messageIndex, partIndex } = completeMessageInfo;
  const searchParams = new URLSearchParams();

  searchParams.set('chatId', chatId);
  searchParams.set('sessionId', sessionId);
  searchParams.set('lastMessageRank', messageIndex.toString());
  searchParams.set('partIndex', partIndex.toString());
  searchParams.set('lastSubchatIndex', args.subchatIndex.toString());
  if (!completeMessageInfo.transcriptCheckpoint) {
    return { searchParams, update: null };
  }
  const checkpoint = completeMessageInfo.transcriptCheckpoint;
  searchParams.set('transcriptAgentName', checkpoint.agentName);
  searchParams.set('transcriptGeneration', checkpoint.generation.toString());
  searchParams.set('transcriptRevision', checkpoint.revision.toString());
  searchParams.set('transcriptDigest', checkpoint.digest);
  searchParams.set('transcriptMessageCount', checkpoint.messageCount.toString());
  if (
    messageIndex === persistedMessageInfo.messageIndex &&
    partIndex === persistedMessageInfo.partIndex &&
    transcriptCheckpointsEqual(checkpoint, args.persistedTranscriptCheckpoint)
  ) {
    return { searchParams, update: null };
  }

  return { searchParams, update: { messageIndex, partIndex } };
}

export function waitForNewMessages(
  accountId: string,
  chatId: string,
  subchatIndex: number,
  messageIndex: number,
  partIndex: number,
  alertOnNextPartStart: boolean,
  signal?: AbortSignal,
) {
  const hasNewMessages = (lastCompleteMessageInfo: CompleteMessageInfo | null) =>
    lastCompleteMessageInfo !== null &&
    lastCompleteMessageInfo.accountId === accountId &&
    lastCompleteMessageInfo.chatId === chatId &&
    lastCompleteMessageInfo.subchatIndex === subchatIndex &&
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
