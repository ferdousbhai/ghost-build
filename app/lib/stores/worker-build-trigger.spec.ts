import { describe, expect, it } from 'vitest';
import { isWorkerBuildTriggerPath } from './worker-build-trigger';

describe('isWorkerBuildTriggerPath', () => {
  it('matches Worker entrypoints, config, and agent modules', () => {
    expect(isWorkerBuildTriggerPath('/home/project/wrangler.jsonc')).toBe(true);
    expect(isWorkerBuildTriggerPath('/home/project/src/server.ts')).toBe(true);
    expect(isWorkerBuildTriggerPath('/home/project/src/agents/example.ts')).toBe(true);
  });

  it('ignores client-only files', () => {
    expect(isWorkerBuildTriggerPath('/home/project/src/routes/index.tsx')).toBe(false);
  });
});
