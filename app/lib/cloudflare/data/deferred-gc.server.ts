import { sweepAgentGcCandidatesBestEffort } from './agent-gc.server';
import { sweepObjectGcCandidatesBestEffort } from './object-gc.server';

export async function drainDeferredDataGcBestEffort(
  env: Pick<Env, 'APP_STORAGE' | 'BuilderAgent' | 'DB'>,
): Promise<void> {
  await Promise.all([sweepObjectGcCandidatesBestEffort(env), sweepAgentGcCandidatesBestEffort(env)]);
}
