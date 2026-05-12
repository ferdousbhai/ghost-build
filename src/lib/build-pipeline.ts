import type { AgentPlan } from './agent'
import type { BuildCheckResult } from './build-checks'
import { runGeneratedWorkerChecks } from './build-checks'
import type { BuildPreviewResult } from './build-preview'
import { createBuildPreviewResult } from './build-preview'
import type { BuildRepairResult } from './build-repair'
import { repairGeneratedWorkerApp } from './build-repair'
import {
  generateWorkerAppFromPlan,
  type GeneratedWorkerApp,
} from './generated-worker-app'

export type BuildPipelineResult = {
  generatedApp: GeneratedWorkerApp
  checkResult: BuildCheckResult
  preview?: BuildPreviewResult
  repairResult?: BuildRepairResult
}

export function runGeneratedWorkerBuildPipeline({
  origin,
  plan,
}: {
  origin: string
  plan: AgentPlan
}): BuildPipelineResult {
  let generatedApp = generateWorkerAppFromPlan(plan)
  let checkResult = runGeneratedWorkerChecks(generatedApp)
  let repairResult: BuildRepairResult | undefined

  if (checkResult.status === 'failed') {
    repairResult = repairGeneratedWorkerApp({
      checkResult,
      generatedApp,
      plan,
    })
    generatedApp = repairResult.repairedApp
    checkResult = runGeneratedWorkerChecks(generatedApp)
  }

  return {
    generatedApp,
    checkResult,
    preview:
      checkResult.status === 'passed'
        ? createBuildPreviewResult({
            checkResult,
            generatedApp,
            origin,
          })
        : undefined,
    repairResult,
  }
}
