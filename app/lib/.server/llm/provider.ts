import { CLOUDFLARE_WORKERS_AI_MODEL, type WorkersAiRuntimeModelId } from '~/lib/workers-ai-model';
import { MODEL_MAX_OUTPUT_TOKENS } from 'ghostbuild-agent/context-limits';
import { getPiModel, type ModelHandle } from './pi-ai-models';

// Canonical provider is now Pi's ModelHandle. Legacy ai/provider shim removed — Pi is sole path (workshop-backend pattern).

export type WorkersAiAccountCredentials = { binding: Ai };

type PiProvider = {
  handle: ModelHandle;
  maxTokens: number;
};

export function getPiProvider(
  accountCredentials: WorkersAiAccountCredentials,
  modelId: WorkersAiRuntimeModelId = CLOUDFLARE_WORKERS_AI_MODEL,
  settings?: { sessionAffinity?: string },
): PiProvider {
  return {
    handle: getPiModel(accountCredentials, modelId, {
      sessionAffinity: settings?.sessionAffinity,
    }),
    maxTokens: MODEL_MAX_OUTPUT_TOKENS,
  };
}
