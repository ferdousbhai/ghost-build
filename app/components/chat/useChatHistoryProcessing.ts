import { useEffect, useMemo } from 'react';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { createSampler } from '~/utils/sampler';
import { useProcessedMessages, type PartCache } from '~/lib/hooks/useProcessedMessages';
import type { StreamStatus } from '~/lib/common/types';

interface ProcessMessagesOptions {
  messages: GhostbuildMessage[];
  initialMessages: GhostbuildMessage[];
  processMessages: (messages: GhostbuildMessage[]) => void;
  streamStatus: StreamStatus;
}

export function useChatHistoryProcessing(args: {
  messages: GhostbuildMessage[];
  initialMessages: GhostbuildMessage[];
  partCache: PartCache;
  streamStatus: StreamStatus;
}) {
  const { parsedMessages, processMessages } = useProcessedMessages(args.partCache);
  const { messages, initialMessages, streamStatus } = args;
  const processSampledMessages = useMemo(
    () =>
      createSampler((options: ProcessMessagesOptions) => {
        options.processMessages(options.messages);
      }, 50),
    [],
  );

  useEffect(() => {
    processSampledMessages({
      messages,
      initialMessages,
      streamStatus,
      processMessages,
    });
  }, [initialMessages, messages, processMessages, processSampledMessages, streamStatus]);

  useEffect(() => () => processSampledMessages.cancel(), [processSampledMessages]);

  return parsedMessages;
}
