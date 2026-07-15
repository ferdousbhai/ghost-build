import { describe, expect, test } from 'vitest';
import type { GhostbuildMessage } from 'ghostbuild-agent/ai-compat';
import { DEPLOYMENT_PLAN_MARKER } from '~/lib/deployment-plan-marker';
import { latestMessageHasPendingDeploymentPlan, latestPendingDeploymentPlanMarker } from './deployment-continuation';

describe('latestMessageHasPendingDeploymentPlan', () => {
  test('stops the automatic continuation after a deploy plan result', () => {
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
            output: `Ready\n${DEPLOYMENT_PLAN_MARKER}{"id":"deployment-1"}`,
          },
        ],
      },
    ];

    expect(latestMessageHasPendingDeploymentPlan(messages)).toBe(true);
    expect(latestPendingDeploymentPlanMarker(messages)).toBe(`${DEPLOYMENT_PLAN_MARKER}{"id":"deployment-1"}`);
  });

  test('does not stop a later user-requested turn', () => {
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
            output: `${DEPLOYMENT_PLAN_MARKER}{"id":"deployment-1"}`,
          },
        ],
      },
      { id: 'user-2', role: 'user', parts: [{ type: 'text', text: 'Change the title.' }] },
    ];

    expect(latestMessageHasPendingDeploymentPlan(messages)).toBe(false);
    expect(latestPendingDeploymentPlanMarker(messages)).toBeNull();
  });
});
