import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

export function listTemplateSourceFiles(rootDir) {
  const output = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'template'], {
    cwd: rootDir,
    encoding: 'utf8',
  });

  return output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((path) => resolve(rootDir, path))
    .filter(existsSync)
    .sort((left, right) => left.localeCompare(right));
}

export function templateSourceDigest(rootDir, files = listTemplateSourceFiles(rootDir)) {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(relative(resolve(rootDir, 'template'), file).replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}
