import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { hasTooManyConsecutiveToolFailures } from './chat-message-utils';

export function buildBuilderAgentRequest(args: {
  messages: GhostbuildMessage[];
  body: Record<string, unknown> | undefined;
  chatInitialId: string;
  subchatIndex: number;
}): Record<string, unknown> {
  return {
    ...args.body,
    chatInitialId: args.chatInitialId,
    subchatIndex: args.subchatIndex,
    shouldDisableTools: hasTooManyConsecutiveToolFailures(args.messages),
  };
}
