import { MAX_EPHEMERAL_CONTEXT_CHARACTERS } from 'ghostbuild-agent/context-limits';

export function filesToTurnContext(
  files: { [path: string]: { content: string } },
  maximumCharacters = MAX_EPHEMERAL_CONTEXT_CHARACTERS,
): string {
  const heading = 'User-modified workspace files:\n';
  const contentBudget = Math.max(0, Math.trunc(maximumCharacters) - heading.length);
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
    const section = `File ${JSON.stringify(filePath)}:\n${file.content}`;
    if (!append(section)) {
      omittedPaths.push(filePath);
    }
  }

  if (omittedPaths.length > 0) {
    const header = 'Modified files omitted from this context; use read to inspect them:';
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

  return sections.length ? `${heading}${sections.join('\n')}` : '';
}
