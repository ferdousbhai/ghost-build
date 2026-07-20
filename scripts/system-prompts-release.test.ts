import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { buildSystemPromptsRelease } from '../buildSystemPrompts';
import {
  createSystemPromptsRelease,
  nextSystemPromptsReleaseTag,
  systemPromptsReleaseArgs,
} from './create-system-prompts-release.mjs';

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('system prompts release artifact', () => {
  test('produces the same bytes and hash across builds at different times', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ghostbuild-system-prompts-'));
    temporaryDirectories.push(directory);
    const firstPath = join(directory, 'first.txt');
    const secondPath = join(directory, 'second.txt');

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    buildSystemPromptsRelease(firstPath);
    vi.setSystemTime(new Date('2030-12-31T23:59:59.999Z'));
    buildSystemPromptsRelease(secondPath);

    const first = readFileSync(firstPath);
    const second = readFileSync(secondPath);
    expect(second).toEqual(first);
    expect(sha256(second)).toBe(sha256(first));
    expect(first.toString('utf8')).not.toContain('Generated on:');
  });

  test('release workflow watches every source and toolchain input', () => {
    const workflow = readFileSync(new URL('../.github/workflows/release_system_prompts.yml', import.meta.url), 'utf8');
    const requiredInputs = [
      '.github/actions/setup-and-build/action.yaml',
      '.github/workflows/release_system_prompts.yml',
      '.nvmrc',
      'buildSystemPrompts.ts',
      'ghostbuild-agent/prompts/**',
      'ghostbuild-agent/utils/stripIndent.ts',
      'ghostbuild-agent/package.json',
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'scripts/create-system-prompts-release.mjs',
    ];

    for (const input of requiredInputs) {
      expect(workflow).toContain(`- '${input}'`);
    }
    expect(workflow.match(/node dist\/buildSystemPrompts\.js/g)).toHaveLength(2);
    expect(workflow).toContain('test "$first_hash" = "$second_hash"');
    expect(workflow).toContain('run: node scripts/create-system-prompts-release.mjs');
    expect(workflow).not.toContain('rymndhng/release-on-push-action');
  });

  test('selects the next semantic prompt release without trusting malformed tags', () => {
    expect(nextSystemPromptsReleaseTag([])).toBe('prompts-v0.0.1');
    expect(
      nextSystemPromptsReleaseTag([
        'prompts-v1.9.10',
        'prompts-v1.10.2',
        'prompts-v2.0.0-rc1',
        'prompts-v02.0.0',
        'unrelated-v99.0.0',
      ]),
    ).toBe('prompts-v1.10.3');
  });

  test('creates the release with validated arguments and no command shell', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ghostbuild-system-prompts-release-'));
    temporaryDirectories.push(directory);
    writeFileSync(join(directory, 'ghostbuild-system-prompts.txt'), 'compiled prompts');
    const spawn = vi.fn(() => ({ status: 0 }));
    const commitSha = 'a'.repeat(40);

    expect(
      createSystemPromptsRelease({ commitSha, cwd: directory, spawn, tags: ['prompts-v4.3.2'], tagsAtCommit: [] }),
    ).toBe('prompts-v4.3.3');
    expect(spawn).toHaveBeenCalledWith('gh', systemPromptsReleaseArgs('prompts-v4.3.3', commitSha), {
      cwd: directory,
      stdio: 'inherit',
    });
  });

  test('is idempotent when the commit already has a published prompt release', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ghostbuild-system-prompts-rerun-'));
    temporaryDirectories.push(directory);
    writeFileSync(join(directory, 'ghostbuild-system-prompts.txt'), 'compiled prompts');
    const spawn = vi.fn(() => ({ status: 0 }));

    expect(
      createSystemPromptsRelease({
        commitSha: 'b'.repeat(40),
        cwd: directory,
        spawn,
        tags: ['prompts-v2.0.0'],
        tagsAtCommit: ['prompts-v2.0.0'],
      }),
    ).toBe('prompts-v2.0.0');
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith('gh', ['release', 'view', 'prompts-v2.0.0', '--json', 'tagName'], {
      cwd: directory,
      stdio: 'ignore',
    });
  });

  test('reuses an existing commit tag when a previous run did not create its release', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ghostbuild-system-prompts-recovery-'));
    temporaryDirectories.push(directory);
    writeFileSync(join(directory, 'ghostbuild-system-prompts.txt'), 'compiled prompts');
    const spawn = vi.fn().mockReturnValueOnce({ status: 1 }).mockReturnValueOnce({ status: 0 });
    const commitSha = 'c'.repeat(40);

    expect(
      createSystemPromptsRelease({
        commitSha,
        cwd: directory,
        spawn,
        tags: ['prompts-v2.0.0'],
        tagsAtCommit: ['prompts-v2.0.0'],
      }),
    ).toBe('prompts-v2.0.0');
    expect(spawn).toHaveBeenLastCalledWith(
      'gh',
      systemPromptsReleaseArgs('prompts-v2.0.0', commitSha, { tagExists: true }),
      { cwd: directory, stdio: 'inherit' },
    );
    expect(systemPromptsReleaseArgs('prompts-v2.0.0', commitSha, { tagExists: true })).toContain('--verify-tag');
  });

  test('does not mistake an indeterminate release lookup for a missing release', () => {
    const directory = mkdtempSync(join(tmpdir(), 'ghostbuild-system-prompts-lookup-'));
    temporaryDirectories.push(directory);
    writeFileSync(join(directory, 'ghostbuild-system-prompts.txt'), 'compiled prompts');

    expect(() =>
      createSystemPromptsRelease({
        commitSha: 'd'.repeat(40),
        cwd: directory,
        spawn: vi.fn(() => ({ status: null })),
        tags: ['prompts-v2.0.0'],
        tagsAtCommit: ['prompts-v2.0.0'],
      }),
    ).toThrow('gh release view failed with exit status unknown');
  });

  test('rejects invalid revisions and symbolic-link artifacts', () => {
    expect(() => systemPromptsReleaseArgs('prompts-v1.0.0', 'main')).toThrow('full lowercase Git commit SHA');

    const directory = mkdtempSync(join(tmpdir(), 'ghostbuild-system-prompts-symlink-'));
    temporaryDirectories.push(directory);
    writeFileSync(join(directory, 'target.txt'), 'compiled prompts');
    symlinkSync('target.txt', join(directory, 'ghostbuild-system-prompts.txt'));
    expect(() =>
      createSystemPromptsRelease({
        commitSha: 'a'.repeat(40),
        cwd: directory,
        spawn: vi.fn(() => ({ status: 0 })),
        tags: [],
        tagsAtCommit: [],
      }),
    ).toThrow('must be a regular, non-symbolic-link file');
  });
});

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}
