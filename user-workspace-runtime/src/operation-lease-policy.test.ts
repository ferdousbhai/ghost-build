import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BUILDER_TURN_TIMEOUTS } from '../../app/lib/.server/llm/builder-turn-budget';
import {
  OPERATION_LANE_TOOLS,
  OPERATION_LEASE_MS,
  OPERATION_TOOL_BUDGET_MS,
  operationLeasePlan,
  type StatefulOperationKind,
} from './operation-lease-policy';

const kinds = Object.keys(OPERATION_LEASE_MS) as StatefulOperationKind[];

describe('operation lease policy', () => {
  it('never lets a lane lease and the tool budget above it declare different ceilings', () => {
    for (const [kind, tools] of Object.entries(OPERATION_LANE_TOOLS)) {
      const budget = Math.max(...tools.map((tool) => BUILDER_TURN_TIMEOUTS.tools[tool]));
      const plan = operationLeasePlan(kind as StatefulOperationKind);

      // The defect this guard exists for: a lease shorter than the budget above
      // it, with nothing renewing the lane, truncates work the tool layer allows.
      expect(plan.leaseMs >= budget || plan.silenceHorizonMs !== null).toBe(true);
      expect(plan.silenceHorizonMs).toBe(budget);
      expect(OPERATION_TOOL_BUDGET_MS[kind as keyof typeof OPERATION_TOOL_BUDGET_MS]).toBe(budget);
    }
  });

  it('maps every model tool that can hold the workspace to a lane', () => {
    const governed = new Set(Object.values(OPERATION_LANE_TOOLS).flat());

    // read and search_cloudflare_docs never take a lane; everything else must.
    expect([...Object.keys(BUILDER_TURN_TIMEOUTS.tools)].filter((tool) => !governed.has(tool as never))).toEqual([
      'read',
      'search_cloudflare_docs',
    ]);
  });

  it('governs the write lane by the longer of the two tools that share it', () => {
    expect(OPERATION_LANE_TOOLS.write).toEqual(['write', 'edit']);
    expect(OPERATION_TOOL_BUDGET_MS.write).toBe(
      Math.max(BUILDER_TURN_TIMEOUTS.tools.write, BUILDER_TURN_TIMEOUTS.tools.edit),
    );
  });

  it('leaves lanes no model tool can occupy on their lease alone', () => {
    for (const kind of kinds) {
      if (kind in OPERATION_LANE_TOOLS) {
        continue;
      }
      expect(operationLeasePlan(kind)).toEqual({ leaseMs: OPERATION_LEASE_MS[kind], silenceHorizonMs: null });
    }
  });

  it('declares every lane the ProjectWorkspace actually opens', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const opened = new Set(
      [...source.matchAll(/withStatefulOperation\(\s*'([a-z]+)'/g)].map((match) => match[1] as StatefulOperationKind),
    );

    expect([...opened].filter((kind) => !kinds.includes(kind))).toEqual([]);
    expect(kinds.filter((kind) => !opened.has(kind) && kind !== 'deployment')).toEqual([]);
  });

  it('renews exactly the lanes whose lease is shorter than their governing budget', () => {
    for (const kind of kinds) {
      const plan = operationLeasePlan(kind);
      if (plan.silenceHorizonMs === null) {
        continue;
      }
      expect(plan.leaseMs).toBeLessThanOrEqual(plan.silenceHorizonMs);
    }
  });
});
