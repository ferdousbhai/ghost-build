import type { BuildCheckResult } from './build-checks'
import type { GeneratedWorkerApp } from './generated-worker-app'

export type BuildPreviewResult = {
  status: 'ready'
  url: string
  healthUrl: string
  createdAt: string
}

export function createBuildPreviewResult({
  checkResult,
  generatedApp,
  origin,
}: {
  checkResult: BuildCheckResult
  generatedApp: GeneratedWorkerApp
  origin: string
}): BuildPreviewResult {
  if (checkResult.status !== 'passed') {
    throw new Error('Preview requires passing artifact checks.')
  }

  const baseUrl = new URL(`/preview/${generatedApp.workerName}`, origin)

  return {
    status: 'ready',
    url: baseUrl.toString(),
    healthUrl: new URL(`${baseUrl.pathname}/api/health`, origin).toString(),
    createdAt: new Date().toISOString(),
  }
}
