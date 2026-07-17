import { generateText } from 'ai';
import { z } from 'zod';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { getProvider } from '~/lib/.server/llm/provider';
import { ENHANCE_PROMPT_SYSTEM_PROMPT } from './enhance-prompt-prompt';
import { resolveAgentRequestIdentity } from '~/lib/.server/agent-request-identity';
import { getUserWorkersAiCredentials } from '~/lib/.server/cloudflare/workers-ai-billing-context';
import { isWorkersAiFreeAllocationError, workersPaidRequiredMessage } from '~/lib/workers-paid';

const logger = createScopedLogger('EnhancePrompt');
const requestSchema = z.object({ prompt: z.string().min(1) });
const ENHANCE_PROMPT_MAX_OUTPUT_TOKENS = 2_048;

export async function enhancePromptAction({ request, env }: { request: Request; env: Env }) {
  const parsedRequest = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsedRequest.success) {
    return Response.json({ error: 'Invalid prompt' }, { status: 400 });
  }

  const identity = await resolveAgentRequestIdentity(request, env);
  if (!identity) {
    return Response.json({ error: 'Cloudflare authentication is required.' }, { status: 401 });
  }

  try {
    const { prompt } = parsedRequest.data;
    const accountCredentials = await getUserWorkersAiCredentials(env, identity.userId);
    const completion = await generateText({
      model: getProvider(env, accountCredentials).model,
      system: ENHANCE_PROMPT_SYSTEM_PROMPT,
      prompt,
      temperature: 0.4,
      maxOutputTokens: ENHANCE_PROMPT_MAX_OUTPUT_TOKENS,
    });
    return Response.json({ enhancedPrompt: completion.text || prompt });
  } catch (error) {
    if (isWorkersAiFreeAllocationError(error)) {
      return Response.json({ code: 'workers_paid_required', error: workersPaidRequiredMessage() }, { status: 402 });
    }
    logger.error('Error enhancing prompt:', error);
    return Response.json({ error: 'Error enhancing prompt' }, { status: 500 });
  }
}
