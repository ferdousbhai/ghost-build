export const WORK_DIR_NAME = 'project';
export const WORK_DIR = `/home/${WORK_DIR_NAME}`;

export const PREWARM_PATHS = [
  `${WORK_DIR}/package.json`,
  `${WORK_DIR}/wrangler.jsonc`,
  `${WORK_DIR}/src/server.ts`,
  `${WORK_DIR}/src/workers-ai.shared.ts`,
  `${WORK_DIR}/src/agents/app-agent.ts`,
  `${WORK_DIR}/src/routes/index.tsx`,
  `${WORK_DIR}/src/styles.css`,
];

// A list of files that we block the LLM from modifying
export const EXCLUDED_FILE_PATHS = [
  'vite.config.ts',
  'package.json',
  'src/routeTree.gen.ts',
  'worker-configuration.d.ts',
];
