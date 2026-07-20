import { path as nodePath } from 'ghostbuild-agent/utils/path';
import { isLocalSecretFilePath } from '~/utils/secretFiles';

const EXCLUDED_SEGMENTS = new Set(['.git', '.output', '.tanstack', '.wrangler', 'coverage', 'dist', 'node_modules']);
const GENERATED_FILE_NAMES = new Set(['routeTree.gen.ts', 'worker-configuration.d.ts']);

export function isRepositoryRetrievalPath(filePath: string, isBinary = false): boolean {
  if (isBinary || isLocalSecretFilePath(filePath) || GENERATED_FILE_NAMES.has(nodePath.basename(filePath))) {
    return false;
  }
  return !filePath.split('/').some((segment) => EXCLUDED_SEGMENTS.has(segment));
}

export function matchesProjectGlob(filePath: string, glob: string | undefined): boolean {
  if (!glob) {
    return true;
  }
  const relativePath = filePath.replace(/^\/home\/project\/?/, '');
  return globToRegExp(glob.replace(/^\/?/, '')).test(relativePath);
}

function globToRegExp(glob: string): RegExp {
  let source = '^';
  for (let index = 0; index < glob.length; index++) {
    const character = glob[index];
    if (character === '*') {
      if (glob[index + 1] === '*') {
        if (glob[index + 2] === '/') {
          source += '(?:.*/)?';
          index += 2;
        } else {
          source += '.*';
          index++;
        }
      } else {
        source += '[^/]*';
      }
      continue;
    }
    if (character === '?') {
      source += '[^/]';
      continue;
    }
    source += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(`${source}$`);
}
