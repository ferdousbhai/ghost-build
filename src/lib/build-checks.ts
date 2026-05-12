import type { GeneratedWorkerApp } from './generated-worker-app'

export type BuildCheck = {
  name: string
  status: 'passed' | 'failed'
  detail: string
}

export type BuildCheckResult = {
  status: 'passed' | 'failed'
  checks: Array<BuildCheck>
  checkedAt: string
}

export function runGeneratedWorkerChecks(
  generatedApp: GeneratedWorkerApp,
): BuildCheckResult {
  const filePaths = new Set(generatedApp.files.map((file) => file.path))
  const fileByPath = new Map(
    generatedApp.files.map((file) => [file.path, file.content]),
  )
  const checks: Array<BuildCheck> = [
    requireFile(filePaths, 'package.json'),
    requireFile(filePaths, 'worker.js'),
    requireFile(filePaths, 'wrangler.jsonc'),
    requireFile(filePaths, 'src/routes/index.tsx'),
    requireFile(filePaths, 'src/routes/api/health.ts'),
    requireFile(filePaths, 'README.md'),
    requireContent(
      fileByPath,
      'wrangler.jsonc',
      `"name": "${generatedApp.workerName}"`,
      'Wrangler config targets generated Worker name.',
    ),
    requireContent(
      fileByPath,
      'package.json',
      '"wrangler deploy"',
      'Package scripts include deploy command.',
    ),
    requireContent(
      fileByPath,
      'worker.js',
      'export default',
      'Generated Worker module uses module syntax.',
    ),
    requireContent(
      fileByPath,
      'worker.js',
      '"/api/health"',
      'Generated Worker module exposes a health route.',
    ),
  ]

  return {
    status: checks.every((check) => check.status === 'passed')
      ? 'passed'
      : 'failed',
    checks,
    checkedAt: new Date().toISOString(),
  }
}

function requireFile(filePaths: Set<string>, path: string): BuildCheck {
  return filePaths.has(path)
    ? {
        name: path,
        status: 'passed',
        detail: `${path} exists.`,
      }
    : {
        name: path,
        status: 'failed',
        detail: `${path} is missing.`,
      }
}

function requireContent(
  fileByPath: Map<string, string>,
  path: string,
  expected: string,
  detail: string,
): BuildCheck {
  return fileByPath.get(path)?.includes(expected)
    ? {
        name: `${path} content`,
        status: 'passed',
        detail,
      }
    : {
        name: `${path} content`,
        status: 'failed',
        detail: `${path} does not include ${expected}.`,
      }
}
