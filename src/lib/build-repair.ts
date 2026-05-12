import type { AgentPlan } from './agent'
import type { BuildCheckResult } from './build-checks'
import {
  generateWorkerAppFromPlan,
  type GeneratedWorkerApp,
  type GeneratedWorkerFile,
} from './generated-worker-app'

export type BuildRepairResult = {
  status: 'repaired' | 'unchanged'
  repairedApp: GeneratedWorkerApp
  repairedFiles: Array<string>
  repairedAt: string
}

export function repairGeneratedWorkerApp({
  checkResult,
  generatedApp,
  plan,
}: {
  checkResult: BuildCheckResult
  generatedApp: GeneratedWorkerApp
  plan: AgentPlan
}): BuildRepairResult {
  if (checkResult.status !== 'failed') {
    return {
      status: 'unchanged',
      repairedApp: generatedApp,
      repairedFiles: [],
      repairedAt: new Date().toISOString(),
    }
  }

  const baseline = generateWorkerAppFromPlan(plan)
  const baselineFiles = new Map(baseline.files.map((file) => [file.path, file]))
  const nextFiles = new Map(generatedApp.files.map((file) => [file.path, file]))
  const repairedFiles = new Set<string>()

  for (const check of checkResult.checks) {
    if (check.status !== 'failed') {
      continue
    }

    const path = pathFromCheckName(check.name)
    const replacement = baselineFiles.get(path)

    if (!replacement) {
      continue
    }

    nextFiles.set(path, replacement)
    repairedFiles.add(path)
  }

  return {
    status: repairedFiles.size > 0 ? 'repaired' : 'unchanged',
    repairedApp: {
      ...generatedApp,
      files: preserveBaselineFileOrder(baseline.files, [...nextFiles.values()]),
    },
    repairedFiles: [...repairedFiles],
    repairedAt: new Date().toISOString(),
  }
}

function pathFromCheckName(name: string) {
  return name.endsWith(' content') ? name.replace(/ content$/, '') : name
}

function preserveBaselineFileOrder(
  baselineFiles: Array<GeneratedWorkerFile>,
  files: Array<GeneratedWorkerFile>,
) {
  const nextFiles = new Map(files.map((file) => [file.path, file]))
  const ordered = baselineFiles.flatMap((file) => {
    const next = nextFiles.get(file.path)

    if (!next) {
      return []
    }

    nextFiles.delete(file.path)
    return [next]
  })

  return [...ordered, ...nextFiles.values()]
}
