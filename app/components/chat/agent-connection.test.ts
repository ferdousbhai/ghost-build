import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForAgentSocketOpen, type AgentSocketLike } from './agent-connection';

class FakeAgentSocket extends EventTarget implements AgentSocketLike {
  OPEN: number | undefined = 1;
  identified: boolean | undefined = false;
  ready: Promise<unknown> | undefined;
  readyState: number | undefined = 0;
  connectionError = null;
}

describe('waitForAgentSocketOpen', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves immediately when the socket is already open', async () => {
    const agent = new FakeAgentSocket();
    agent.readyState = agent.OPEN;
    agent.ready = undefined;

    await expect(waitForAgentSocketOpen(agent, 10)).resolves.toBeUndefined();
  });

  it('resolves immediately when the agent is already identified', async () => {
    const agent = new FakeAgentSocket();
    agent.identified = true;
    agent.readyState = agent.OPEN;
    agent.ready = new Promise(() => undefined);

    await expect(waitForAgentSocketOpen(agent, 10)).resolves.toBeUndefined();
  });

  it('still waits for a new socket when a previous connection was identified', async () => {
    const agent = new FakeAgentSocket();
    agent.identified = true;
    const ready = waitForAgentSocketOpen(agent, 100);
    let resolved = false;
    ready.then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    agent.readyState = agent.OPEN;
    agent.dispatchEvent(new Event('open'));

    await expect(ready).resolves.toBeUndefined();
  });

  it('waits for the socket open event when socket state is available', async () => {
    const agent = new FakeAgentSocket();
    agent.ready = undefined;
    const ready = waitForAgentSocketOpen(agent, 100);

    agent.readyState = agent.OPEN;
    agent.dispatchEvent(new Event('open'));

    await expect(ready).resolves.toBeUndefined();
  });

  it('waits for the agent identity handshake after the socket opens', async () => {
    const agent = new FakeAgentSocket();
    agent.readyState = agent.OPEN;
    let resolveIdentity!: () => void;
    agent.ready = new Promise<void>((resolve) => {
      resolveIdentity = resolve;
    });
    const ready = waitForAgentSocketOpen(agent, 100);
    let resolved = false;
    ready.then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    resolveIdentity();

    await expect(ready).resolves.toBeUndefined();
  });

  it('can resolve after socket open without waiting for an identity frame', async () => {
    const agent = new FakeAgentSocket();
    agent.readyState = agent.OPEN;
    agent.ready = new Promise(() => undefined);

    await expect(waitForAgentSocketOpen(agent, 10, { requireIdentity: false })).resolves.toBeUndefined();
  });

  it('still waits for the socket to open when identity is not required', async () => {
    const agent = new FakeAgentSocket();
    agent.ready = new Promise(() => undefined);
    const ready = waitForAgentSocketOpen(agent, 100, { requireIdentity: false });
    let resolved = false;
    ready.then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);

    agent.readyState = agent.OPEN;
    agent.dispatchEvent(new Event('open'));

    await expect(ready).resolves.toBeUndefined();
  });

  it('times out on a closed socket even when identity is not required', async () => {
    vi.useFakeTimers();
    const agent = new FakeAgentSocket();
    const ready = waitForAgentSocketOpen(agent, 100, { requireIdentity: false });
    const rejection = expect(ready).rejects.toThrow('Ghostbuild could not connect to the builder');

    await vi.advanceTimersByTimeAsync(100);

    await rejection;
  });

  it('rejects if a known socket never opens', async () => {
    vi.useFakeTimers();
    const agent = new FakeAgentSocket();
    agent.ready = undefined;
    const ready = waitForAgentSocketOpen(agent, 100);
    const rejection = expect(ready).rejects.toThrow('Ghostbuild could not connect to the builder');

    await vi.advanceTimersByTimeAsync(100);

    await rejection;
  });

  it('rejects if the socket opens but the identity handshake never completes', async () => {
    vi.useFakeTimers();
    const agent = new FakeAgentSocket();
    agent.readyState = agent.OPEN;
    agent.ready = new Promise(() => undefined);
    const ready = waitForAgentSocketOpen(agent, 100);
    const rejection = expect(ready).rejects.toThrow('Ghostbuild could not connect to the builder');

    await vi.advanceTimersByTimeAsync(100);

    await rejection;
  });

  it('falls back to the chat transport when socket state fields are unavailable', async () => {
    const agent = new FakeAgentSocket();
    agent.OPEN = undefined;
    agent.readyState = undefined;
    agent.ready = undefined;

    await expect(waitForAgentSocketOpen(agent, 10)).resolves.toBeUndefined();
  });

  it('waits for identity even when socket state fields are unavailable', async () => {
    const agent = new FakeAgentSocket();
    agent.OPEN = undefined;
    agent.readyState = undefined;
    let resolveIdentity!: () => void;
    agent.ready = new Promise<void>((resolve) => {
      resolveIdentity = resolve;
    });
    const ready = waitForAgentSocketOpen(agent, 100);

    resolveIdentity();

    await expect(ready).resolves.toBeUndefined();
  });
});
