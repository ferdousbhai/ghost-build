import type { GeneratedWorkerApp, GeneratedWorkerFile } from './generated-worker-app'

export type GeneratedWorkerPatch =
  | {
      operation: 'upsert'
      path: string
      content: string
    }
  | {
      operation: 'delete'
      path: string
    }

export type GeneratedWorkerPatchResult = {
  patchedApp: GeneratedWorkerApp
  changedFiles: Array<string>
  patchedAt: string
}

export function applyGeneratedWorkerPatches(
  generatedApp: GeneratedWorkerApp,
  patches: Array<GeneratedWorkerPatch>,
): GeneratedWorkerPatchResult {
  if (!patches.length) {
    return {
      patchedApp: generatedApp,
      changedFiles: [],
      patchedAt: new Date().toISOString(),
    }
  }

  const files = new Map(generatedApp.files.map((file) => [file.path, file]))
  const changedFiles = new Set<string>()

  for (const patch of patches) {
    assertSafeGeneratedPath(patch.path)

    if (patch.operation === 'delete') {
      files.delete(patch.path)
      changedFiles.add(patch.path)
      continue
    }

    files.set(patch.path, {
      path: patch.path,
      content: patch.content,
    })
    changedFiles.add(patch.path)
  }

  return {
    patchedApp: {
      ...generatedApp,
      files: sortGeneratedFiles([...files.values()]),
    },
    changedFiles: [...changedFiles],
    patchedAt: new Date().toISOString(),
  }
}

function assertSafeGeneratedPath(path: string) {
  if (
    !path ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.split('/').includes('..')
  ) {
    throw new Error('Generated file patch path must stay inside the app.')
  }
}

function sortGeneratedFiles(files: Array<GeneratedWorkerFile>) {
  return files.sort((left, right) => left.path.localeCompare(right.path))
}
