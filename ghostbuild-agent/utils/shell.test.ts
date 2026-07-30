import { describe, expect, it } from 'vitest';
import { cleanTerminalOutput } from './shell.js';

describe('shell output cleanup', () => {
  it('removes ANSI codes and normalizes whitespace', () => {
    expect(cleanTerminalOutput('\x1b[31mError:\x1b[0m   failed\r\n\n\nnext')).toBe('Error: failed\nnext');
  });
});
