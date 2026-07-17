import { useEffect, useMemo } from 'react';
import { toast } from 'sonner';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { createSampler } from '~/utils/sampler';
import { useMessageParser, type PartCache } from '~/lib/hooks/useMessageParser';
import type { StreamStatus } from '~/lib/common/types';
import type { StoreMessageHistory } from './chat-types';
import type { TranscriptCheckpoint } from 'ghostbuild-agent/transcript';

interface ProcessMessagesOptions {
  messages: GhostbuildMessage[];
  initialMessages: GhostbuildMessage[];
  parseMessages: (messages: GhostbuildMessage[]) => void;
  streamStatus: StreamStatus;
  storeMessageHistory: StoreMessageHistory;
  transcriptCheckpoint: TranscriptCheckpoint | null;
}

export function useChatHistoryProcessing(args: {
  messages: GhostbuildMessage[];
  initialMessages: GhostbuildMessage[];
  partCache: PartCache;
  streamStatus: StreamStatus;
  storeMessageHistory: StoreMessageHistory;
  transcriptCheckpoint: TranscriptCheckpoint | null;
}) {
  const { parsedMessages, parseMessages } = useMessageParser(args.partCache);
  const { messages, initialMessages, streamStatus, storeMessageHistory } = args;
  const processSampledMessages = useMemo(
    () =>
      createSampler((options: ProcessMessagesOptions) => {
        options.parseMessages(options.messages);
        if (options.messages.length >= options.initialMessages.length) {
          Promise.resolve(
            options.storeMessageHistory(options.messages, options.streamStatus, options.transcriptCheckpoint),
          ).catch((error) => toast.error(error instanceof Error ? error.message : 'Failed to save message history'));
        }
      }, 50),
    [],
  );

  useEffect(() => {
    processSampledMessages({
      messages,
      initialMessages,
      streamStatus,
      storeMessageHistory,
      parseMessages,
      transcriptCheckpoint: args.transcriptCheckpoint,
    });
  }, [
    args.transcriptCheckpoint,
    initialMessages,
    messages,
    parseMessages,
    processSampledMessages,
    storeMessageHistory,
    streamStatus,
  ]);

  useEffect(() => () => processSampledMessages.cancel(), [processSampledMessages]);

  return parsedMessages;
}
