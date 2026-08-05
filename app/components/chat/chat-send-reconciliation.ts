import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import {
  transcriptCheckpointMatchesMessages,
  transcriptCheckpointsEqual,
  type TranscriptCheckpoint,
} from 'ghostbuild-agent/transcript';

export async function reconcileMessagesForSend(args: {
  durableCheckpoint: TranscriptCheckpoint | null;
  localMessages: GhostbuildMessage[];
  loadedCheckpoint: TranscriptCheckpoint | null;
  loadedMessages: GhostbuildMessage[];
}): Promise<GhostbuildMessage[] | null> {
  if (await transcriptCheckpointMatchesMessages(args.durableCheckpoint, args.localMessages)) {
    return args.localMessages;
  }
  if (
    transcriptCheckpointsEqual(args.durableCheckpoint, args.loadedCheckpoint) &&
    (await transcriptCheckpointMatchesMessages(args.durableCheckpoint, args.loadedMessages))
  ) {
    return args.loadedMessages;
  }
  return null;
}
