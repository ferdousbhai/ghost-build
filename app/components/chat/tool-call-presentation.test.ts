import { describe, expect, it } from 'vitest';
import { compactToolLabel } from './tool-call-presentation';

describe('Computer tool-call presentation', () => {
  it('keeps untrusted paths and commands to one bounded title line', () => {
    expect(compactToolLabel('find src\n  -type   f')).toBe('find src -type f');

    const rendered = compactToolLabel('x'.repeat(1_000));
    expect(rendered).toHaveLength(160);
    expect(rendered.endsWith('…')).toBe(true);
  });
});
