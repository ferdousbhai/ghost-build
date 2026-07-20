import { WORK_DIR } from 'ghostbuild-agent/constants';
import { path } from 'ghostbuild-agent/utils/path';

const WORKER_BUILD_TRIGGER_FILES = new Set([
  path.join(WORK_DIR, 'wrangler.jsonc'),
  path.join(WORK_DIR, 'src/server.ts'),
  path.join(WORK_DIR, 'src/workers-ai.shared.ts'),
]);
const WORKER_BUILD_TRIGGER_AGENT_DIR = path.join(WORK_DIR, 'src/agents');

export function isWorkerBuildTriggerPath(filePath: string): boolean {
  return (
    WORKER_BUILD_TRIGGER_FILES.has(filePath) ||
    filePath === WORKER_BUILD_TRIGGER_AGENT_DIR ||
    filePath.startsWith(`${WORKER_BUILD_TRIGGER_AGENT_DIR}/`)
  );
}
