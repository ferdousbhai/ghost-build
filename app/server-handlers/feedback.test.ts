import { beforeEach, describe, expect, it, vi } from 'vitest';

const getAuthSession = vi.hoisted(() => vi.fn());

vi.mock('~/lib/.server/auth', () => ({
  getAuthSession,
}));

import { feedbackAction } from './feedback';

type BoundStatement = {
  values: unknown[];
  run: () => Promise<{ success: boolean; meta: { changes: number } }>;
};

function createEnv(changes = 1) {
  const statements: BoundStatement[] = [];
  const prepare = vi.fn((_sql: string) => ({
    bind: (...values: unknown[]) => {
      const statement: BoundStatement = {
        values,
        run: async () => ({ success: true, meta: { changes } }),
      };
      statements.push(statement);
      return statement;
    },
  }));
  const env = { DB: { prepare }, WORKERS_CI_COMMIT_SHA: 'test-sha' } as unknown as Env;
  return { env, prepare, statements };
}

function request(body: unknown) {
  return new Request('https://ghostbuild.dev/api/feedback', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'CF-Connecting-IP': '192.0.2.1' },
    body: JSON.stringify(body),
  });
}

describe('feedbackAction', () => {
  beforeEach(() => {
    getAuthSession.mockReset();
    getAuthSession.mockResolvedValue(null);
  });

  it('rejects invalid feedback', async () => {
    const { env, prepare } = createEnv();
    const response = await feedbackAction({ request: request({ category: 'idea', message: '  ' }), env });

    expect(response.status).toBe(400);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('rejects an oversized JSON body before storing feedback', async () => {
    const { env, prepare } = createEnv();
    const response = await feedbackAction({
      request: request({ category: 'idea', message: 'Valid feedback', padding: 'x'.repeat(16 * 1024) }),
      env,
    });

    expect(response.status).toBe(413);
    expect(prepare).not.toHaveBeenCalled();
  });

  it('stores valid feedback with private context', async () => {
    getAuthSession.mockResolvedValue({ user: { id: 'user-123' } });
    const { env, statements } = createEnv();
    const response = await feedbackAction({
      request: request({ category: 'ux', message: 'Make the preview easier to find.', pagePath: '/chat/example' }),
      env,
    });

    expect(response.status).toBe(201);
    expect(statements).toHaveLength(1);
    expect(statements[0].values).toEqual([
      expect.any(String),
      'user-123',
      'ux',
      'Make the preview easier to find.',
      '/chat/example',
      'test-sha',
      'user:user-123',
      expect.any(Number),
      'user:user-123',
      expect.any(Number),
      5,
    ]);
  });

  it('rate limits repeated submissions', async () => {
    const { env, prepare } = createEnv(0);
    const response = await feedbackAction({
      request: request({ category: 'bug', message: 'Something is not working.' }),
      env,
    });

    expect(response.status).toBe(429);
    expect(prepare).toHaveBeenCalledTimes(1);
  });
});
