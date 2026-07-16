import { describe, expect, test } from 'vitest';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { DEPLOYMENT_PLAN_MARKER } from '~/lib/deployment-approval';
import { latestMessageHasPendingDeploymentPlan, latestPendingDeploymentPlanMarker } from './deployment-continuation';

describe('latestMessageHasPendingDeploymentPlan', () => {
  test('stops the automatic continuation after a deploy plan result', () => {
    const marker = `${DEPLOYMENT_PLAN_MARKER}${JSON.stringify({
      id: 'deployment-1',
      planDigest: 'a'.repeat(64),
      resources: [],
    })}`;
    const messages: GhostbuildMessage[] = [
      {
        id: 'assistant-1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-deploy',
            toolCallId: 'deploy-1',
            state: 'output-available',
            input: {},
            output: `Ready\n${marker}`,
          },
        ],
      },
    ];

    expect(latestMessageHasPendingDeploymentPlan(messages)).toBe(true);
    expect(latestPendingDeploymentPlanMarker(messages)).toBe(marker);
  });

  test('does not stop a later user-requested turn', () => {
    const marker = `${DEPLOYMENT_PLAN_MARKER}${JSON.stringify({
      id: 'deployment-1',
      planDigest: 'a'.repeat(64),
      resources: [],
    })}`;
    const messages: GhostbuildMessage[] = [
      {
        id: 'assistant-1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-deploy',
            toolCallId: 'deploy-1',
            state: 'output-available',
            input: {},
            output: marker,
          },
        ],
      },
      { id: 'user-2', role: 'user', parts: [{ type: 'text', text: 'Change the title.' }] },
    ];

    expect(latestMessageHasPendingDeploymentPlan(messages)).toBe(false);
    expect(latestPendingDeploymentPlanMarker(messages)).toBeNull();
  });

  test('synthesizes the legacy continuation marker from a structured result', () => {
    const messages: GhostbuildMessage[] = [
      {
        id: 'assistant-structured',
        role: 'assistant',
        parts: [
          {
            type: 'tool-deploy',
            toolCallId: 'deploy-structured',
            state: 'output-available',
            input: { validatedRevision: 'b'.repeat(64) },
            output: {
              version: 1,
              ok: true,
              summary: 'ready',
              data: {
                state: 'awaiting-approval',
                revision: 'b'.repeat(64),
                deployment: { id: 'deployment-2', planDigest: 'c'.repeat(64), resources: [] },
              },
            },
          },
        ],
      },
    ];
    expect(latestPendingDeploymentPlanMarker(messages)).toBe(
      `${DEPLOYMENT_PLAN_MARKER}{"id":"deployment-2","planDigest":"${'c'.repeat(64)}","resources":[]}`,
    );
  });
});
