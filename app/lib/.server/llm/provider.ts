import type { LanguageModel } from 'ai';
import { createWorkersAI } from 'workers-ai-provider';
import { CLOUDFLARE_WORKERS_AI_MODEL } from '~/lib/workers-ai-model';
import { MODEL_MAX_OUTPUT_TOKENS } from 'ghostbuild-agent/context-limits';

type Provider = {
  maxTokens: number;
  model: LanguageModel;
};

export type WorkersAiAccountCredentials =
  { accountId: string; apiKey: string; binding?: never } | { binding: Ai; accountId?: never; apiKey?: never };

export function getProvider(
  _env: Env,
  accountCredentials: WorkersAiAccountCredentials,
  modelId: string = CLOUDFLARE_WORKERS_AI_MODEL,
  settings?: { sessionAffinity?: string; feature?: string },
): Provider {
  const cloudflare = createWorkersAI({
    ...accountCredentials,
    gateway: { id: 'default', collectLog: false },
  });

  return {
    model: cloudflare(modelId, {
      sessionAffinity: settings?.sessionAffinity,
      metadata: {
        ghostbuild_feature: settings?.feature ?? 'supporting-model-call',
        ghostbuild_source: 'user-runtime',
      },
      collectLog: false,
      extraHeaders: {
        'cf-aig-collect-log': 'false',
        'cf-aig-collect-log-payload': 'false',
      },
    }),
    maxTokens: MODEL_MAX_OUTPUT_TOKENS,
  };
}
