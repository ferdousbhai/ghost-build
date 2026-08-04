import type { TranscriptIdentity } from 'ghostbuild-agent/transcript';
import type { WorkersAiModelId } from '~/lib/workers-ai-model';

export type WorkersAiPromptCacheStatus = 'hit' | 'miss' | 'unavailable';

export async function createWorkersAiSessionAffinity(
  identity: TranscriptIdentity,
  modelId: WorkersAiModelId,
): Promise<string> {
  return `gb-${await sha256Hex(
    JSON.stringify({
      agentName: identity.agentName,
      subchatIndex: identity.subchatIndex,
      generation: identity.generation,
      modelId,
    }),
  )}`;
}

export async function fingerprintWorkersAiModelInput(input: {
  privacySalt: string;
  model: string;
  instructions: unknown;
  messages: unknown;
  tools: unknown;
  activeTools: unknown;
  toolChoice: unknown;
}): Promise<string> {
  return sha256Hex(JSON.stringify(input));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
