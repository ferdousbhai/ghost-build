import { generateTitle, type TitleSubject } from '~/lib/title-generation';
import { CLOUDFLARE_PROJECT_TITLE_MODEL } from '~/lib/workers-ai-model';
import { getPiModel } from './pi-ai-models';
import type { WorkersAiAccountCredentials } from './pi-ai-models';
import { completeText } from './pi-ai-invoke';

export function generateProjectTitle(
  prompt: string,
  accountCredentials: WorkersAiAccountCredentials,
): Promise<string | null> {
  return generateModelTitle(prompt, 'project', accountCredentials);
}

export function generateConversationTitle(
  prompt: string,
  accountCredentials: WorkersAiAccountCredentials,
): Promise<string | null> {
  return generateModelTitle(prompt, 'conversation', accountCredentials);
}

async function generateModelTitle(
  prompt: string,
  subject: TitleSubject,
  accountCredentials: WorkersAiAccountCredentials,
): Promise<string | null> {
  const handle = getPiModel(accountCredentials, CLOUDFLARE_PROJECT_TITLE_MODEL);
  const generated = await generateTitle({
    execute: async (request) => ({
      text: await completeText(handle, {
        prompt: request.prompt,
        maxTokens: request.maxOutputTokens,
        temperature: request.temperature,
      }),
    }),
    prompt,
    subject,
  });
  return generated?.title ?? null;
}
