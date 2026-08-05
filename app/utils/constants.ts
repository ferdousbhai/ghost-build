import { WORK_DIR } from 'ghostbuild-agent/constants';

export const PENDING_PROMPT_STORAGE_KEY = 'ghostbuild:pending-prompt';

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
