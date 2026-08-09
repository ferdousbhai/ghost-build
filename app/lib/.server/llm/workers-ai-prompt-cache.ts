import type { TranscriptIdentity } from 'ghostbuild-agent/transcript';
import type { WorkersAiModelId } from '~/lib/workers-ai-model';

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

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
