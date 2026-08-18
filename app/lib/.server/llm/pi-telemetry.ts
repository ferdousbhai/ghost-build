import type { BuilderTurnBudgetReport } from './builder-turn-budget';

export function recordPiStage(stage: string, modelId: string, status?: number): void {
  console.info({ event: 'ghostbuild_pi_stage', stage, modelId, ...(status === undefined ? {} : { status }) });
}

export function recordPiTurnBudget(modelId: string, budget: BuilderTurnBudgetReport): void {
  console.info({ event: 'ghostbuild_pi_turn_budget', modelId, ...budget });
}
