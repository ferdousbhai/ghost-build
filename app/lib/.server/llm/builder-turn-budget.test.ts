import { describe, expect, it } from 'vitest';
import { WORKSPACE_READ_ONLY_TOOL_NAMES } from 'ghostbuild-agent/model-tool-inputs';
import {
  BUILDER_MUTATION_TOOL_TIMEOUT_MS,
  BUILDER_TURN_BUDGET_ERROR_CODE,
  BUILDER_TURN_TIMEOUTS,
  BuilderTurnBudgetExceededError,
} from './builder-turn-budget';

describe('builder tool budgets', () => {
  it('keeps short read-only deadlines and a shared long-running mutation deadline', () => {
    expect(BUILDER_TURN_TIMEOUTS.tools).toEqual({
      read: 2 * 60_000,
      ls: 60_000,
      grep: 60_000,
      write: BUILDER_MUTATION_TOOL_TIMEOUT_MS,
      edit: BUILDER_MUTATION_TOOL_TIMEOUT_MS,
      exec: BUILDER_MUTATION_TOOL_TIMEOUT_MS,
      search_cloudflare_docs: 60_000,
    });
    expect(BUILDER_MUTATION_TOOL_TIMEOUT_MS).toBe(35 * 60_000);
  });

  it('never gives a VFS-only tool a container-sized deadline', () => {
    for (const tool of WORKSPACE_READ_ONLY_TOOL_NAMES) {
      expect(BUILDER_TURN_TIMEOUTS.tools[tool]).toBeLessThan(BUILDER_MUTATION_TOOL_TIMEOUT_MS);
    }
  });

  it('exposes a typed retryable tool-timeout payload', () => {
    const error = new BuilderTurnBudgetExceededError('tool_timeout');

    expect(error).toMatchObject({
      name: 'BuilderTurnBudgetExceededError',
      code: BUILDER_TURN_BUDGET_ERROR_CODE,
      reason: 'tool_timeout',
    });
    expect(JSON.parse(error.message)).toMatchObject({
      code: BUILDER_TURN_BUDGET_ERROR_CODE,
      reason: 'tool_timeout',
      retryable: true,
    });
  });
});
