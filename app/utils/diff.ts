import { createTwoFilesPatch } from 'diff';
import type { AbsolutePath } from 'ghostbuild-agent/utils/workDir';
import type { FileMap } from 'ghostbuild-agent/types';

interface ModifiedFile {
  type: 'diff' | 'file';
  content: string;
}

type FileModifications = Record<AbsolutePath, ModifiedFile>;

export function computeFileModifications(files: FileMap, modifiedFiles: Map<AbsolutePath, string>) {
  const modifications: FileModifications = {};
  let hasModifications = false;

  for (const [filePath, originalContent] of modifiedFiles) {
    const file = files[filePath];

    if (file?.type !== 'file') {
      continue;
    }

    const unifiedDiff = diffFiles(filePath, originalContent, file.content);

    if (!unifiedDiff) {
      // files are identical
      continue;
    }

    modifications[filePath] =
      unifiedDiff.length > file.content.length
        ? { type: 'file', content: file.content }
        : { type: 'diff', content: unifiedDiff };
    hasModifications = true;
  }

  return hasModifications ? modifications : undefined;
}

/**
 * Computes a diff in the unified format. The only difference is that the header is omitted
 * because it will always assume that you're comparing two versions of the same file and
 * it allows us to avoid the extra characters we send back to the llm.
 *
 * @see https://www.gnu.org/software/diffutils/manual/html_node/Unified-Format.html
 */
function diffFiles(fileName: string, oldFileContent: string, newFileContent: string) {
  let unifiedDiff = createTwoFilesPatch(fileName, fileName, oldFileContent, newFileContent);

  const patchHeaderEnd = `--- ${fileName}\n+++ ${fileName}\n`;
  const headerEndIndex = unifiedDiff.indexOf(patchHeaderEnd);

  if (headerEndIndex >= 0) {
    unifiedDiff = unifiedDiff.slice(headerEndIndex + patchHeaderEnd.length);
  }

  return unifiedDiff || undefined;
}
