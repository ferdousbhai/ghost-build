import { useCallback } from 'react';
import { lastCompleteMessageInfoStore } from '~/lib/stores/startup/messages';
import { isToolPart, isToolResult, type GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import type { StreamStatus } from '~/lib/common/types';
import { digestTranscriptMessages, type TranscriptCheckpoint } from 'ghostbuild-agent/transcript';

/**
 * This returns a function that takes in `messages` and `streamStatus` and updates
 * the state of the last complete part of the messages (e.g. tool invocation that has finished, text part that is done streaming, etc.).
 *
 * The `chatSyncWorker` reads from this state and persists it to the database.
 *
 * The startup history hook owns the related `beforeunload` protection so this
 * callback remains a pure store update.
 */
export function useStoreMessageHistory() {
  return useCallback(
    async (
      messages: GhostbuildMessage[],
      streamStatus: StreamStatus,
      transcriptCheckpoint: TranscriptCheckpoint | null,
    ) => {
      if (messages.length === 0 || transcriptCheckpoint === null || streamStatus === 'streaming') {
        return;
      }

      const lastCompleteMessageInfo = getLastCompletePart(messages, streamStatus);
      if (lastCompleteMessageInfo === null) {
        return;
      }
      if (transcriptCheckpoint.digest !== (await digestTranscriptMessages(messages))) {
        return;
      }
      const currentLastCompleteMessageInfo = lastCompleteMessageInfoStore.get();
      if (
        currentLastCompleteMessageInfo !== null &&
        lastCompleteMessageInfo.messageIndex === currentLastCompleteMessageInfo.messageIndex &&
        lastCompleteMessageInfo.partIndex === currentLastCompleteMessageInfo.partIndex &&
        transcriptCheckpoint.revision === currentLastCompleteMessageInfo.transcriptCheckpoint?.revision &&
        transcriptCheckpoint.digest === currentLastCompleteMessageInfo.transcriptCheckpoint?.digest
      ) {
        return;
      }
      lastCompleteMessageInfoStore.set({
        messageIndex: lastCompleteMessageInfo.messageIndex,
        partIndex: lastCompleteMessageInfo.partIndex,
        allMessages: messages,
        hasNextPart: lastCompleteMessageInfo.hasNextPart,
        transcriptCheckpoint,
      });
    },
    [],
  );
}

function getPrecedingPart(
  messages: GhostbuildMessage[],
  args: { messageIndex: number; partIndex: number },
): { messageIndex: number; partIndex: number } | null {
  if (messages.length === 0) {
    return null;
  }
  if (args.messageIndex >= messages.length) {
    let messageIndex = messages.length - 1;
    while (messageIndex >= 0) {
      const message = messages[messageIndex];
      const parts = message.parts ?? [];
      if (parts.length > 0) {
        return { messageIndex, partIndex: parts.length - 1 };
      }
      messageIndex--;
    }
    return null;
  }
  const message = messages[args.messageIndex];
  const parts = message.parts ?? [];
  if (args.partIndex >= parts.length) {
    return { messageIndex: args.messageIndex, partIndex: parts.length - 1 };
  }
  if (args.partIndex === 0) {
    let messageIndex = args.messageIndex - 1;
    while (messageIndex >= 0) {
      const message = messages[messageIndex];
      const parts = message.parts ?? [];
      if (parts.length > 0) {
        return { messageIndex, partIndex: parts.length - 1 };
      }
      messageIndex--;
    }
    return null;
  }
  return { messageIndex: args.messageIndex, partIndex: args.partIndex - 1 };
}

// Exported for testing
export function getLastCompletePart(
  messages: GhostbuildMessage[],
  streamStatus: StreamStatus,
): { messageIndex: number; partIndex: number; hasNextPart: boolean } | null {
  if (messages.length === 0) {
    return null;
  }
  const lastPartIndices = getPrecedingPart(messages, { messageIndex: messages.length, partIndex: 0 });
  if (lastPartIndices === null) {
    return null;
  }
  const lastMessage = messages[lastPartIndices.messageIndex];
  const lastPart = lastMessage.parts?.[lastPartIndices.partIndex];
  if (lastPart === null || lastPart === undefined) {
    throw new Error('Last part is missing');
  }

  const isLastPartComplete = isToolResult(lastPart) || (!isToolPart(lastPart) && streamStatus !== 'streaming');
  if (isLastPartComplete) {
    return {
      messageIndex: lastPartIndices.messageIndex,
      partIndex: lastPartIndices.partIndex,
      // This handles the edge case where the last message is empty
      hasNextPart: lastPartIndices.messageIndex !== messages.length - 1,
    };
  }
  const precedingPart = getPrecedingPart(messages, lastPartIndices);
  if (precedingPart === null) {
    return null;
  }
  return { messageIndex: precedingPart.messageIndex, partIndex: precedingPart.partIndex, hasNextPart: true };
}
