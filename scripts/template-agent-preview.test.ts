import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { getAgentByName } from '../template/src/preview/agents';

describe('generated app preview agent shim', () => {
  test('renders both complete TanStack routes and partial default-export generations', () => {
    const previewEntry = readFileSync(new URL('../template/src/preview/main.tsx', import.meta.url), 'utf8');

    expect(previewEntry).toContain('import * as PreviewRoute from "../routes/index"');
    expect(previewEntry).toContain('previewRouteModule.Route?.options.component ?? previewRouteModule.default');
  });

  test('exports a safe resolver stub for server-bound agent routing', async () => {
    const agent = await getAgentByName();
    await expect(agent.refreshAnonymousSessionExpiry()).resolves.toBe(true);
    const response = await agent.fetch();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: 'Durable Agent requests are unavailable in static preview mode.',
    });
  });
});
