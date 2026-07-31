import { z } from 'zod';
import { transcriptCheckpointSchema, type TranscriptCheckpoint } from 'ghostbuild-agent/transcript';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';

const builderStopMessageSchema = z
  .object({
    id: z.string().min(1),
    role: z.enum(['user', 'assistant', 'system']),
    parts: z.array(z.unknown()),
  })
  .passthrough();

const builderStopResultSchema = z.object({
  checkpoint: transcriptCheckpointSchema.nullable(),
  messages: z.array(builderStopMessageSchema),
});

type BuilderStopResult = {
  checkpoint: TranscriptCheckpoint | null;
  messages: GhostbuildMessage[];
};

export async function settleBuilderStop(args: {
  cancel: () => Promise<unknown>;
  reconcileMessages: (messages: GhostbuildMessage[]) => void;
  refreshWorkspace: () => Promise<void>;
}): Promise<BuilderStopResult> {
  const parsed = builderStopResultSchema.safeParse(await args.cancel());
  if (!parsed.success) {
    throw new Error('The builder returned an invalid transcript after cancellation. Reload and try again.');
  }
  const result = parsed.data as BuilderStopResult;
  args.reconcileMessages(result.messages);
  await args.refreshWorkspace();
  return result;
}
