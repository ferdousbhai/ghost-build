import { atom } from 'nanostores';
import { compressWithLz4 } from '~/lib/compression';
import { waitForStoreCondition } from '~/lib/stores/waitForStore';
import { createdAtMillis, messageText, type GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import {
  TRANSCRIPT_HISTORY_FORMAT_VERSION,
  stripTranscriptBaseMetadata,
  transcriptCheckpointsEqual,
  type TranscriptCheckpoint,
} from 'ghostbuild-agent/transcript';

const textEncoder = new TextEncoder();

export type CompleteMessageInfo = {
  messageIndex: number;
  partIndex: number;
  hasNextPart: boolean;
  allMessages: GhostbuildMessage[];
  transcriptCheckpoint: TranscriptCheckpoint | null;
};

export type SerializedMessage = Omit<GhostbuildMessage, 'createdAt' | 'content'> & {
  createdAt: number | undefined;
  content?: string;
};

type StoredMessageHistory = {
  version: typeof TRANSCRIPT_HISTORY_FORMAT_VERSION;
  transcript: TranscriptCheckpoint;
  messages: SerializedMessage[];
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
    compressed: Uint8Array;
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

  const compressed = compressMessages(allMessages, messageIndex, partIndex, checkpoint);
  return { url, update: { compressed, messageIndex, partIndex, firstMessage } };
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
  // `content` + `toolInvocations` are duplicated in `parts`; annotations are legacy metadata.
  // We should avoid storing them since we already store `parts`.
  const {
    content: _content,
    toolInvocations: _toolInvocations,
    annotations: _annotations,
    parts,
    ...rest
  } = stripTranscriptBaseMetadata(message) as GhostbuildMessage & {
    annotations?: unknown[];
    toolInvocations?: unknown[];
  };

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

function compressMessages(
  messages: GhostbuildMessage[],
  lastMessageRank: number,
  partIndex: number,
  transcript: TranscriptCheckpoint,
): Uint8Array {
  const history: StoredMessageHistory = {
    version: TRANSCRIPT_HISTORY_FORMAT_VERSION,
    transcript,
    messages: serializeCompleteMessages(messages, lastMessageRank, partIndex),
  };
  const uint8Array = textEncoder.encode(JSON.stringify(history));
  return compressWithLz4(uint8Array);
}
