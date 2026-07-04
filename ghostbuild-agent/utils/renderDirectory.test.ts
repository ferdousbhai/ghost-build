import { describe, expect, it } from 'vitest';
import { renderDirectory } from './renderDirectory.js';

describe('renderDirectory', () => {
  it('renders child names and entry types', () => {
    expect(
      renderDirectory([
        { name: 'src', isDirectory: () => true },
        { name: 'package.json', isDirectory: () => false },
      ]),
    ).toBe('Directory:\n- src (dir)\n- package.json (file)');
  });
});
