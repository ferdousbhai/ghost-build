import type { WorkersAiAccountCredentials } from '~/lib/.server/llm/provider';

export async function getUserWorkersAiCredentials(env: Env, userId: string): Promise<WorkersAiAccountCredentials> {
  if (!userId) {
    throw new Error('Cloudflare authentication is required.');
  }
  const runtime = env as Env & { GHOSTBUILD_USER_RUNTIME?: string; AI?: Ai };
  if (runtime.GHOSTBUILD_USER_RUNTIME !== '1' || !runtime.AI) {
    throw new Error('Workers AI must run through the user-owned Cloudflare runtime binding.');
  }
  return { binding: runtime.AI };
}
