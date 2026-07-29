import { getRelativePath } from 'ghostbuild-agent/utils/workDir';
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
