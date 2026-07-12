import { generateText } from 'ai';
import { z } from 'zod';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { getProvider } from '~/lib/.server/llm/provider';
import { ENHANCE_PROMPT_SYSTEM_PROMPT } from './enhance-prompt-prompt';

const logger = createScopedLogger('EnhancePrompt');
const requestSchema = z.object({ prompt: z.string().min(1) });

export async function enhancePromptAction({ request, env }: { request: Request; env: Env }) {
  const parsedRequest = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsedRequest.success) {
    return Response.json({ error: 'Invalid prompt' }, { status: 400 });
  }

  try {
    const { prompt } = parsedRequest.data;
    const completion = await generateText({
      model: getProvider(env).model,
      system: ENHANCE_PROMPT_SYSTEM_PROMPT,
      prompt,
      temperature: 0.4,
      maxOutputTokens: 2048,
    });

    return Response.json({ enhancedPrompt: completion.text || prompt });
  } catch (error) {
    logger.error('Error enhancing prompt:', error);
    return Response.json({ error: 'Error enhancing prompt' }, { status: 500 });
  }
}
