import type { DirEnt } from '@webcontainer/api';
import { getRelativePath } from 'ghostbuild-agent/utils/workDir';
import type { WebContainer } from '@webcontainer/api';

export function filesToArtifacts(files: { [path: string]: { content: string } }, id: string): string {
  const actions = Object.entries(files).map(
    ([filePath, file]) => `<boltAction type="file" filePath="${filePath}">
${file.content}
</boltAction>`,
  );

  return [`<boltArtifact id="${id}" title="User Updated Files">`, ...actions, '</boltArtifact>'].join('\n');
}

export function workDirRelative(absPath: string) {
  // The agent often sends relative paths instead of absolute paths, so we should just return that.
  return getRelativePath(absPath);
}

function compareDirEnts(a: DirEnt<string>, b: DirEnt<string>) {
  const directoryOrder = Number(b.isDirectory()) - Number(a.isDirectory());
  return directoryOrder || a.name.localeCompare(b.name);
}

async function readDir(container: WebContainer, relPath: string): Promise<DirEnt<string>[]> {
  const children = await container.fs.readdir(relPath, {
    withFileTypes: true,
  });
  children.sort(compareDirEnts);
  return children;
}

export async function readPath(
  container: WebContainer,
  relPath: string,
): Promise<{ type: 'directory'; children: DirEnt<string>[] } | { type: 'file'; content: string; isBinary: boolean }> {
  // There isn't a way to stat a path in the container, so try reading
  // it as a directory first.
  try {
    const children = await readDir(container, relPath);
    return { type: 'directory', children };
  } catch (error) {
    if (!(error instanceof Error) || typeof error.message !== 'string') {
      throw error;
    }
    if (!error.message.startsWith('ENOTDIR')) {
      throw error;
    }
    // If we made it here, the path isn't a directory, so let's
    // try it as a file below.
  }
  const content = await container.fs.readFile(relPath, 'utf-8');
  return { type: 'file', content, isBinary: false };
}
