import type { DirEnt } from '@webcontainer/api';
import { getRelativePath } from 'ghostbuild-agent/utils/workDir';
import type { WebContainer } from '@webcontainer/api';
import { MAX_EPHEMERAL_CONTEXT_CHARACTERS } from 'ghostbuild-agent/context-limits';

export function filesToArtifacts(
  files: { [path: string]: { content: string } },
  id: string,
  maximumCharacters = MAX_EPHEMERAL_CONTEXT_CHARACTERS,
): string {
  const open = `<boltArtifact id="${escapeXmlAttribute(id)}" title="User Updated Files">\n`;
  const close = '\n</boltArtifact>';
  const contentBudget = Math.max(0, Math.trunc(maximumCharacters) - open.length - close.length);
  const sections: string[] = [];
  const omittedPaths: string[] = [];
  let size = 0;

  const append = (value: string): boolean => {
    const separatorSize = sections.length ? 1 : 0;
    if (size + separatorSize + value.length > contentBudget) {
      return false;
    }
    sections.push(value);
    size += separatorSize + value.length;
    return true;
  };

  for (const [filePath, file] of Object.entries(files).sort(([left], [right]) => left.localeCompare(right))) {
    const action = `<boltAction type="file" filePath="${escapeXmlAttribute(filePath)}">\n${file.content}\n</boltAction>`;
    if (!append(action)) {
      omittedPaths.push(filePath);
    }
  }

  if (omittedPaths.length > 0) {
    const header = 'Modified files omitted from this context; use view to inspect them:';
    const lines = [header];
    let summarySize = header.length;
    for (const filePath of omittedPaths) {
      const line = `\n- ${filePath}`;
      if (size + (sections.length ? 1 : 0) + summarySize + line.length > contentBudget) {
        break;
      }
      lines.push(line);
      summarySize += line.length;
    }
    append(lines.join(''));
  }

  return sections.length ? `${open}${sections.join('\n')}${close}` : '';
}

function escapeXmlAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
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
