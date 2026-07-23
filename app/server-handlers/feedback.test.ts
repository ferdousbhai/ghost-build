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
  const env = { DB: { prepare }, COMMIT_SHA: 'test-sha' } as unknown as Env;
  return { env, prepare, statements };
}

function request(body: unknown) {
  return new Request('https://ghostbuild.dev/api/feedback', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'CF-Connecting-IP': '192.0.2.1',
      Origin: 'https://ghostbuild.dev',
    },
    body: JSON.stringify(body),
  });
}

describe('feedbackAction', () => {
  beforeEach(() => {
    getAuthSession.mockReset();
    getAuthSession.mockResolvedValue(null);
  });

  it('rejects cross-origin submissions before parsing, authentication, or storage', async () => {
    const { env, prepare } = createEnv();
    const crossOrigin = request({ category: 'idea', message: 'Cross-origin spam.' });
    crossOrigin.headers.set('Origin', 'https://attacker.example');

    const response = await feedbackAction({ request: crossOrigin, env });

    expect(response.status).toBe(403);
    expect(getAuthSession).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it('rejects requests without a browser origin', async () => {
    const { env, prepare } = createEnv();
    const missingOrigin = request({ category: 'idea', message: 'Missing origin.' });
    missingOrigin.headers.delete('Origin');

    const response = await feedbackAction({ request: missingOrigin, env });

    expect(response.status).toBe(403);
    expect(prepare).not.toHaveBeenCalled();
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
