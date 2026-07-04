import type { LanguageModel } from 'ai';
import { createWorkersAI } from 'workers-ai-provider';
import { CLOUDFLARE_WORKERS_AI_MODEL } from '~/lib/workers-ai-model';

type Provider = {
  maxTokens: number;
  model: LanguageModel;
};

export function getProvider(env: Env): Provider {
  const cloudflare = createWorkersAI({ binding: env.AI });

  return {
    model: cloudflare(CLOUDFLARE_WORKERS_AI_MODEL),
    maxTokens: 24576,
  };
}
