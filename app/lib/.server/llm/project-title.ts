import { generateText } from 'ai';
import { generateTitle } from '@summonghost/title-generation';
import { CLOUDFLARE_PROJECT_TITLE_MODEL } from '~/lib/workers-ai-model';
import { getProvider, type WorkersAiAccountCredentials } from './provider';

export async function generateProjectTitle(
  env: Env,
  prompt: string,
  accountCredentials: WorkersAiAccountCredentials,
): Promise<string | null> {
  const generated = await generateTitle({
    execute: (request) =>
      generateText({
        model: getProvider(env, accountCredentials, CLOUDFLARE_PROJECT_TITLE_MODEL).model,
        ...request,
      }),
    firstPrompt: prompt,
    subject: 'project',
  });
  return generated?.title ?? null;
}

export { normalizeGeneratedTitle as cleanProjectTitle } from '@summonghost/title-generation';
