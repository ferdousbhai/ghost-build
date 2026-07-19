import { beforeEach, describe, expect, it, vi } from 'vitest';

const sweepObjectGcCandidatesBestEffort = vi.hoisted(() => vi.fn());
const sweepAgentGcCandidatesBestEffort = vi.hoisted(() => vi.fn());

vi.mock('./object-gc.server', () => ({ sweepObjectGcCandidatesBestEffort }));
vi.mock('./agent-gc.server', () => ({ sweepAgentGcCandidatesBestEffort }));

import { drainDeferredDataGcBestEffort } from './deferred-gc.server';

describe('deferred data cleanup drain', () => {
  beforeEach(() => {
    sweepObjectGcCandidatesBestEffort.mockReset().mockResolvedValue(undefined);
    sweepAgentGcCandidatesBestEffort.mockReset().mockResolvedValue(undefined);
  });

  it('fans out to the independently bounded R2 and BuilderAgent queues', async () => {
    const env = {} as Pick<Env, 'APP_STORAGE' | 'BuilderAgent' | 'DB'>;

    await drainDeferredDataGcBestEffort(env);

    expect(sweepObjectGcCandidatesBestEffort).toHaveBeenCalledWith(env);
    expect(sweepAgentGcCandidatesBestEffort).toHaveBeenCalledWith(env);
  });
});
