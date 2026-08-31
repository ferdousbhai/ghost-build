import { describe, expect, it } from 'vitest';
import { cloudflareExecutePausesTurn } from './pi-agent-runner';

describe('Pi approval turn boundary', () => {
  it('stops after a cloudflare_execute proposal so approval resumes as a later user turn', () => {
    const proposal = {
      kind: 'cloudflare_execute_proposal',
      status: 'awaiting_approval',
      executionId: 'execution-1',
      toolCallId: 'tool-1',
      accountId: 'account-1',
      code: 'return mutate()',
      proposalSha256: 'a'.repeat(64),
      riskNote: 'risk',
      expiresAt: Date.now() + 60_000,
    };

    expect(cloudflareExecutePausesTurn('cloudflare_execute', proposal)).toBe(true);
    expect(cloudflareExecutePausesTurn('cloudflare_search', proposal)).toBe(false);
    expect(
      cloudflareExecutePausesTurn('cloudflare_execute', {
        kind: 'cloudflare_execute_result',
        status: 'succeeded',
      }),
    ).toBe(false);
  });
});
