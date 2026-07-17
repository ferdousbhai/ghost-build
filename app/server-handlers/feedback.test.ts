import { beforeEach, describe, expect, it, vi } from 'vitest';

const getAuthSession = vi.hoisted(() => vi.fn());

vi.mock('~/lib/.server/auth', () => ({
  getAuthSession,
}));

import { feedbackAction } from './feedback';

type BoundStatement = {
  values: unknown[];
  first?: () => Promise<{ count: number }>;
  run?: () => Promise<{ success: boolean }>;
};

function createEnv(count = 0) {
  const statements: BoundStatement[] = [];
  const prepare = vi.fn((sql: string) => ({
    bind: (...values: unknown[]) => {
      const statement: BoundStatement = { values };
      if (sql.startsWith('SELECT')) {
        statement.first = async () => ({ count });
      } else {
        statement.run = async () => ({ success: true });
      }
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

  it('stores valid feedback with private context', async () => {
    getAuthSession.mockResolvedValue({ user: { id: 'user-123' } });
    const { env, statements } = createEnv();
    const response = await feedbackAction({
      request: request({ category: 'ux', message: 'Make the preview easier to find.', pagePath: '/chat/example' }),
      env,
    });

    expect(response.status).toBe(201);
    expect(statements).toHaveLength(2);
    expect(statements[0].values[0]).toBe('user:user-123');
    expect(statements[1].values).toEqual([
      expect.any(String),
      'user-123',
      'ux',
      'Make the preview easier to find.',
      '/chat/example',
      'test-sha',
      'user:user-123',
      expect.any(Number),
    ]);
  });

  it('rate limits repeated submissions', async () => {
    const { env, prepare } = createEnv(5);
    const response = await feedbackAction({
      request: request({ category: 'bug', message: 'Something is not working.' }),
      env,
    });

    expect(response.status).toBe(429);
    expect(prepare).toHaveBeenCalledTimes(1);
  });
});
