import { beforeEach, describe, expect, test, vi } from 'vitest';
import { handleAgentSessionBootstrap, resolveAgentSession } from '../template/src/agent-security';
import { routeAppAgentRequest, type AppAgentRoutingEnv } from '../template/src/agent-routing';

vi.mock('../template/src/agent-security', () => ({
  handleAgentSessionBootstrap: vi.fn(),
  resolveAgentSession: vi.fn(),
}));

const env = { DB: {}, AppAgent: {} } as unknown as AppAgentRoutingEnv;
const resolveAppAgent = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveAgentSession).mockResolvedValue(null);
});

describe('generated app server agent routing', () => {
  test('does not expose default client-selected agent routes', async () => {
    const response = await routeAppAgentRequest(
      new Request('https://app.example/agents/app-agent/stolen'),
      env,
      resolveAppAgent,
    );
    expect(response?.status).toBe(404);
    expect(resolveAppAgent).not.toHaveBeenCalled();
  });

  test('requires a valid server session before forwarding the fixed agent route', async () => {
    const request = new Request('https://app.example/agent', {
      headers: { Origin: 'https://app.example' },
    });
    const response = await routeAppAgentRequest(request, env, resolveAppAgent);
    expect(response?.status).toBe(401);
    expect(resolveAppAgent).not.toHaveBeenCalled();

    const crossOrigin = await routeAppAgentRequest(
      new Request('https://app.example/agent', {
        headers: { Origin: 'https://attacker.example' },
      }),
      env,
      resolveAppAgent,
    );
    expect(crossOrigin?.status).toBe(403);
    expect(resolveAgentSession).toHaveBeenCalledTimes(1);

    const refreshAnonymousSessionExpiry = vi.fn(async () => true);
    const fetchAgent = vi.fn(async () => new Response('agent'));
    vi.mocked(resolveAgentSession).mockResolvedValue({
      agentName: 'session-server-private',
      expiresAt: 604_805_000,
    });
    resolveAppAgent.mockResolvedValue({ refreshAnonymousSessionExpiry, fetch: fetchAgent });
    const authorized = await routeAppAgentRequest(request, env, resolveAppAgent);
    expect(authorized?.status).toBe(200);
    expect(resolveAppAgent).toHaveBeenCalledWith(env.AppAgent, 'session-server-private');
    expect(refreshAnonymousSessionExpiry).toHaveBeenCalledWith(604_805_000);
    expect(fetchAgent).toHaveBeenCalledWith(request);
  });

  test('does not forward a session that expires before its Agent retention is armed', async () => {
    const refreshAnonymousSessionExpiry = vi.fn(async () => false);
    const fetchAgent = vi.fn(async () => new Response('agent'));
    vi.mocked(resolveAgentSession).mockResolvedValue({
      agentName: 'session-expired-during-routing',
      expiresAt: 5_000,
    });
    resolveAppAgent.mockResolvedValue({ refreshAnonymousSessionExpiry, fetch: fetchAgent });

    const response = await routeAppAgentRequest(
      new Request('https://app.example/agent', { headers: { Origin: 'https://app.example' } }),
      env,
      resolveAppAgent,
    );

    expect(response?.status).toBe(401);
    expect(fetchAgent).not.toHaveBeenCalled();
  });

  test('delegates only the session bootstrap endpoint to the session control', async () => {
    const expected = new Response(null, { status: 204 });
    vi.mocked(handleAgentSessionBootstrap).mockResolvedValue(expected);
    const request = new Request('https://app.example/api/agent/session', {
      method: 'POST',
    });
    await expect(routeAppAgentRequest(request, env, resolveAppAgent)).resolves.toBe(expected);
    expect(handleAgentSessionBootstrap).toHaveBeenCalledWith(request, env.DB);
    await expect(routeAppAgentRequest(new Request('https://app.example/'), env, resolveAppAgent)).resolves.toBeNull();
  });
});
