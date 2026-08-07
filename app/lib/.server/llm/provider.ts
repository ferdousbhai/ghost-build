import { CLOUDFLARE_WORKERS_AI_MODEL } from '~/lib/workers-ai-model';
import { MODEL_MAX_OUTPUT_TOKENS } from 'ghostbuild-agent/context-limits';
import { getPiModel, type ModelHandle } from './pi-ai-models';

// Canonical provider is now Pi's ModelHandle. Legacy ai/provider shim removed — Pi is sole path (workshop-backend pattern).

export type WorkersAiAccountCredentials =
  | { accountId: string; apiKey: string; binding?: never }
  | { binding: Ai; accountId?: never; apiKey?: never };

export type PiProvider = {
  handle: ModelHandle;
  maxTokens: number;
};

export type Provider = PiProvider;

export function getPiProvider(
  accountCredentials: WorkersAiAccountCredentials,
  modelId: string = CLOUDFLARE_WORKERS_AI_MODEL,
  settings?: { sessionAffinity?: string },
): PiProvider {
  return {
    handle: getPiModel(accountCredentials, modelId as never, {
      sessionAffinity: settings?.sessionAffinity,
    }),
    maxTokens: MODEL_MAX_OUTPUT_TOKENS,
  };
}

export function getProvider(
  _env: Env,
  accountCredentials: WorkersAiAccountCredentials,
  modelId: string = CLOUDFLARE_WORKERS_AI_MODEL,
  settings?: { sessionAffinity?: string; feature?: string },
): Provider {
  return getPiProvider(accountCredentials, modelId, settings);
}
