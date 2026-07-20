import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { hasTooManyConsecutiveToolFailures } from './chat-message-utils';
import type { TranscriptIdentity } from 'ghostbuild-agent/transcript';

export function buildBuilderAgentRequest(args: {
  messages: GhostbuildMessage[];
  body: Record<string, unknown> | undefined;
  chatInitialId: string;
  subchatIndex: number;
  transcript: TranscriptIdentity;
}): Record<string, unknown> {
  return {
    ...args.body,
    chatInitialId: args.chatInitialId,
    subchatIndex: args.subchatIndex,
    transcript: args.transcript,
    shouldDisableTools: hasTooManyConsecutiveToolFailures(args.messages),
  };
}
