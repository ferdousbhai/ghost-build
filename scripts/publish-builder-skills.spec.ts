import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));

describe('builder skill publisher ownership', () => {
  it('refuses to write the production pointer from the Ghostbuild repository', () => {
    const result = spawnSync(process.execPath, ['scripts/publish-builder-skills.mjs', '--remote'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(
      'Production builder skills are published exclusively by ghost-build-ops.',
    );
  });
});
