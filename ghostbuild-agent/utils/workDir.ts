import { WORK_DIR } from '../constants.js';
import { path } from './path.js';

// Relative to `WORK_DIR`
export type RelativePath = string & { __brand: 'RelativePath' };
export type AbsolutePath = string & { __brand: 'AbsolutePath' };

function isWorkDirPath(pathString: string) {
  return pathString === WORK_DIR || pathString.startsWith(`${WORK_DIR}/`);
}

export const getAbsolutePath = (pathString: string): AbsolutePath => {
  return (isWorkDirPath(pathString) ? pathString : path.join(WORK_DIR, pathString)) as AbsolutePath;
};

export const getRelativePath = (pathString: string): RelativePath => {
  return (isWorkDirPath(pathString) ? path.relative(WORK_DIR, pathString) : pathString) as RelativePath;
};
