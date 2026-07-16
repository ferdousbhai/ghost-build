import { path } from 'ghostbuild-agent/utils/path';
import { getAbsolutePath, getRelativePath, type AbsolutePath, type RelativePath } from 'ghostbuild-agent/utils/workDir';

const PROJECT_ROOT = '/home/project';

export function normalizeProjectPath(requestedPath = '.'): {
  absolutePath: AbsolutePath;
  relativePath: RelativePath;
} {
  const absolutePath = path.normalize(getAbsolutePath(requestedPath));
  if (absolutePath !== PROJECT_ROOT && !absolutePath.startsWith(`${PROJECT_ROOT}/`)) {
    throw new Error(`Path must resolve under ${PROJECT_ROOT}.`);
  }
  return {
    absolutePath: absolutePath as AbsolutePath,
    relativePath: (getRelativePath(absolutePath) || '.') as RelativePath,
  };
}
