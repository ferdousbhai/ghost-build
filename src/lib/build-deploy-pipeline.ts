import type { AgentPlan } from './agent'
import type { BuildPipelineResult } from './build-pipeline'
import { runGeneratedWorkerBuildPipeline } from './build-pipeline'
import {
  deployGeneratedWorkerApp,
  type CloudflareDeployResult,
} from './cloudflare-deploy'
import type { CloudflareConnectionStatus } from './cloudflare-status'
import type { DeployApprovalRecord } from './deploy-approval'

export type BuildDeployPipelineResult = BuildPipelineResult & {
  deployResult: CloudflareDeployResult
}

export async function runGeneratedWorkerBuildDeployPipeline({
  approval,
  cloudflareStatus,
  fetcher,
  origin,
  plan,
  token,
}: {
  approval?: DeployApprovalRecord
  cloudflareStatus: CloudflareConnectionStatus
  fetcher?: typeof fetch
  origin: string
  plan: AgentPlan
  token?: string
}): Promise<BuildDeployPipelineResult> {
  const pipeline = runGeneratedWorkerBuildPipeline({ origin, plan })

  return {
    ...pipeline,
    deployResult: await deployGeneratedWorkerApp({
      approval,
      checkResult: pipeline.checkResult,
      cloudflareStatus,
      generatedApp: pipeline.generatedApp,
      plan,
      preview: pipeline.preview,
      token,
      fetcher,
    }),
  }
}
