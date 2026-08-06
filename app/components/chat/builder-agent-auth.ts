import { getUserRuntimeSession } from '~/lib/cloudflare/runtime-session';

export const BUILDER_AGENT_QUERY_CACHE_TTL_MS = 0;

export async function loadBuilderAgentCapability(): Promise<{ capability: string }> {
  return { capability: (await getUserRuntimeSession()).token };
}
