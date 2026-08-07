import { z } from 'zod';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { getPiProvider } from '~/lib/.server/llm/provider';
import { completeText } from '~/lib/.server/llm/pi-ai-invoke';
import { ENHANCE_PROMPT_SYSTEM_PROMPT } from './enhance-prompt-prompt';
import { getUserWorkersAiCredentials } from '~/lib/.server/cloudflare/workers-ai-billing-context';
import { isWorkersAiFreeAllocationError, workersPaidRequiredMessage } from '~/lib/workers-paid';
import { logProviderFailure } from '~/lib/.server/llm/provider-error-logging';
import { InvalidJsonBodyError, PayloadTooLargeError, readJsonBodyWithLimit } from '~/lib/bounded-body';

const logger = createScopedLogger('EnhancePrompt');
const requestSchema = z.object({ prompt: z.string().min(1) });
const ENHANCE_PROMPT_MAX_OUTPUT_TOKENS = 2_048;
const MAX_ENHANCE_PROMPT_REQUEST_BYTES = 64 * 1024;

export async function userRuntimeEnhancePromptAction(args: { request: Request; env: Env; userId: string }) {
  return enhancePromptForUser(args);
}

async function enhancePromptForUser({ request, env, userId }: { request: Request; env: Env; userId: string }) {
  try {
    const parsedRequest = requestSchema.safeParse(
      await readJsonBodyWithLimit(request, MAX_ENHANCE_PROMPT_REQUEST_BYTES, 'Prompt enhancement request'),
    );
    if (!parsedRequest.success) {
      return Response.json({ error: 'Invalid prompt' }, { status: 400 });
    }
    const { prompt } = parsedRequest.data;
    const accountCredentials = await getUserWorkersAiCredentials(env, userId);
    const handle = getPiProvider(accountCredentials).handle;
    const enhancedPrompt = (
      await completeText(handle, {
        systemPrompt: ENHANCE_PROMPT_SYSTEM_PROMPT,
        prompt,
        maxTokens: ENHANCE_PROMPT_MAX_OUTPUT_TOKENS,
      })
    ).trim();
    if (!enhancedPrompt) {
      throw new Error('Workers AI returned an empty enhanced prompt.');
    }
    return Response.json({ enhancedPrompt });
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return Response.json({ error: error.message }, { status: 413 });
    }
    if (error instanceof InvalidJsonBodyError) {
      return Response.json({ error: 'Invalid prompt' }, { status: 400 });
    }
    if (isWorkersAiFreeAllocationError(error)) {
      return Response.json({ code: 'workers_paid_required', error: workersPaidRequiredMessage() }, { status: 402 });
    }
    logProviderFailure(logger, 'Prompt enhancement request failed.', error);
    return Response.json({ error: 'Error enhancing prompt' }, { status: 500 });
  }
}
