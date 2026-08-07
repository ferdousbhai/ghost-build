import { generateTitle } from '@summonghost/title-generation';
import { CLOUDFLARE_PROJECT_TITLE_MODEL } from '~/lib/workers-ai-model';
import { getPiModel } from './pi-ai-models';
import type { WorkersAiAccountCredentials } from './provider';
import { completeText } from './pi-ai-invoke';

export async function generateProjectTitle(
  _env: Env,
  prompt: string,
  accountCredentials: WorkersAiAccountCredentials,
): Promise<string | null> {
  const handle = getPiModel(accountCredentials, CLOUDFLARE_PROJECT_TITLE_MODEL);
  const generated = await generateTitle({
    execute: async (request) =>
      completeText(handle, {
        systemPrompt: request.system,
        prompt: request.prompt,
        maxTokens: request.maxTokens,
      }),
    firstPrompt: prompt,
    subject: 'project',
  });
  return generated?.title ?? null;
}
