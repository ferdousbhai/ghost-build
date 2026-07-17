import type { LanguageModel } from 'ai';
import { createWorkersAI } from 'workers-ai-provider';
import { CLOUDFLARE_WORKERS_AI_MODEL } from '~/lib/workers-ai-model';
import { MODEL_MAX_OUTPUT_TOKENS } from 'ghostbuild-agent/context-limits';

type Provider = {
  maxTokens: number;
  model: LanguageModel;
};

export type WorkersAiAccountCredentials = {
  accountId: string;
  apiKey: string;
};

export function getProvider(
  env: Env,
  accountCredentials?: WorkersAiAccountCredentials,
  modelId = CLOUDFLARE_WORKERS_AI_MODEL,
  settings?: { sessionAffinity?: string },
): Provider {
  const cloudflare = accountCredentials
    ? createWorkersAI({ accountId: accountCredentials.accountId, apiKey: accountCredentials.apiKey })
    : createWorkersAI({ binding: env.AI });

  return {
    model: cloudflare(modelId, { sessionAffinity: settings?.sessionAffinity }),
    maxTokens: MODEL_MAX_OUTPUT_TOKENS,
  };
}
