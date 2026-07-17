import { describe, expect, it, vi } from 'vitest';
import { createAuthSession, getAuthSession, upsertCloudflareUser } from './auth';

describe('Cloudflare auth sessions', () => {
  it('stores only a hash of the opaque cookie and uses secure production cookie attributes', async () => {
    const captured: unknown[] = [];
    const env = {
      DB: {
        prepare: vi.fn(() => ({
          bind: (...values: unknown[]) => ({
            run: async () => {
              captured.push(...values);
              return { success: true };
            },
          }),
        })),
      },
    } as unknown as Env;

    const cookie = await createAuthSession(env, 'user-1', new Request('https://ghostbuild.dev/connect/return'), 1_000);
    const token = cookie.match(/^ghostbuild_session=([^;]+)/)?.[1];
    expect(token).toBeTruthy();
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(captured[1]).toBe('user-1');
    expect(captured[2]).toMatch(/^[0-9a-f]{64}$/);
    expect(captured[2]).not.toBe(token);
  });

  it('accepts a valid session only through an active Cloudflare connection', async () => {
    let query = '';
    let values: unknown[] = [];
    const env = {
      DB: {
        prepare: (sql: string) => {
          query = sql;
          return {
            bind: (...bound: unknown[]) => {
              values = bound;
              return {
                first: async () => ({
                  session_id: 'session-1',
                  user_id: 'user-1',
                  expires_at: Date.now() + 60_000,
                  name: 'Person',
                  email: 'person@example.com',
                  image: null,
                }),
              };
            },
          };
        },
      },
    } as unknown as Env;
    const session = await getAuthSession(
      env,
      new Request('https://ghostbuild.dev/', { headers: { cookie: 'ghostbuild_session=opaque-token' } }),
    );

    expect(query).toContain("connections.status = 'active'");
    expect(values[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(session?.user.id).toBe('user-1');
  });

  it('adopts a matching legacy email so existing projects remain owned by the same user', async () => {
    const updates: unknown[][] = [];
    const db = {
      prepare(sql: string) {
        return {
          bind(...values: unknown[]) {
            return {
              first: async () => {
                if (sql.includes('cloudflare_subject =')) {
                  return null;
                }
                if (sql.includes('WHERE email =')) {
                  return { id: 'legacy-user', name: 'Old', email: 'person@example.com', image: null };
                }
                return null;
              },
              run: async () => {
                updates.push(values);
                return { success: true };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    await expect(
      upsertCloudflareUser(
        db,
        { subject: 'cf-user-1', email: 'person@example.com', name: 'Person', picture: null },
        'Account',
        123,
      ),
    ).resolves.toMatchObject({ id: 'legacy-user', name: 'Person' });
    expect(updates[0]).toEqual(['cf-user-1', 'Person', 'person@example.com', 1, null, 123, 'legacy-user']);
  });
});
