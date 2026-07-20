import { describe, expect, it } from 'vitest';
import { cleanBuildOutput, cleanTerminalOutput } from './shell.js';

describe('shell output cleanup', () => {
  it('removes ANSI codes and normalizes whitespace', () => {
    expect(cleanTerminalOutput('\x1b[31mError:\x1b[0m   failed\r\n\n\nnext')).toBe('Error: failed\nnext');
  });

  it('removes noisy build lines and duplicate spinner lines', () => {
    expect(cleanBuildOutput('transforming (1)\n⠋ building\n⠙ building\nDone')).toBe('building\nDone');
  });

  it('keeps only the last esbuild could-not-resolve error', () => {
    expect(cleanBuildOutput('[ERROR] Could not resolve "a"\nother\n[ERROR] Could not resolve "b"')).toBe(
      '[ERROR] Could not resolve "b"',
    );
  });
});
