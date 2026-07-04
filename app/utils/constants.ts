import { WORK_DIR } from 'ghostbuild-agent/constants';
import { LOCAL_SECRET_FILE_IGNORE_PATHS } from './secretFiles';

export const PROMPT_COOKIE_KEY = 'cachedPrompt';

const IGNORED_RELATIVE_DIRECTORIES = ['dist', 'node_modules', '.output', '.tanstack', '.wrangler'] as const;

export const IGNORED_RELATIVE_PATHS = [...IGNORED_RELATIVE_DIRECTORIES, ...LOCAL_SECRET_FILE_IGNORE_PATHS];

export const IGNORED_PATHS = [
  ...IGNORED_RELATIVE_DIRECTORIES.map((path) => `${WORK_DIR}/${path}/`),
  ...LOCAL_SECRET_FILE_IGNORE_PATHS.map((path) => `${WORK_DIR}/${path}`),
];

export const DEFAULT_COLLAPSED_FOLDERS = new Set([
  `${WORK_DIR}/public`,
  `${WORK_DIR}/.output`,
  `${WORK_DIR}/.tanstack`,
  `${WORK_DIR}/.wrangler`,
  `${WORK_DIR}/src/agents`,
  `${WORK_DIR}/src/components`,
  `${WORK_DIR}/src/lib`,
]);

const MIN_BACKOFF = 500;
const MAX_BACKOFF = 60000;

export function backoffTime(numFailures: number) {
  return Math.min(MIN_BACKOFF * Math.pow(2, numFailures), MAX_BACKOFF) * Math.random();
}

export const MAX_CONSECUTIVE_DEPLOY_ERRORS = 5;
