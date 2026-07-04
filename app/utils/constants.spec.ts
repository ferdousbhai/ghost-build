import { describe, expect, it } from 'vitest';
import { WORK_DIR } from 'ghostbuild-agent/constants';
import { IGNORED_PATHS, IGNORED_RELATIVE_PATHS } from './constants';

describe('ignored file paths', () => {
  it('keeps absolute ignored paths aligned with relative paths', () => {
    expect(IGNORED_RELATIVE_PATHS).toEqual([
      'dist',
      'node_modules',
      '.output',
      '.tanstack',
      '.wrangler',
      '.env',
      '.env.',
      '.env.local',
      '.envrc',
      '.dev.vars',
      '.dev.vars.',
    ]);
    expect(IGNORED_PATHS).toEqual([
      `${WORK_DIR}/dist/`,
      `${WORK_DIR}/node_modules/`,
      `${WORK_DIR}/.output/`,
      `${WORK_DIR}/.tanstack/`,
      `${WORK_DIR}/.wrangler/`,
      `${WORK_DIR}/.env`,
      `${WORK_DIR}/.env.`,
      `${WORK_DIR}/.env.local`,
      `${WORK_DIR}/.envrc`,
      `${WORK_DIR}/.dev.vars`,
      `${WORK_DIR}/.dev.vars.`,
    ]);
  });
});
