import { describe, expect, it } from 'vitest';
import { toolFailure, toolResultContent, toolSuccess } from './tool-result.js';

describe('toolResultContent', () => {
  it('returns string content from a structured tool result', () => {
    expect(toolResultContent(toolSuccess('Viewed file', { content: 'const answer = 42;' }))).toBe('const answer = 42;');
  });

  it('ignores unstructured and non-string content', () => {
    expect(toolResultContent('plain result')).toBeUndefined();
    expect(toolResultContent(toolFailure('No content', { content: { error: true } }))).toBeUndefined();
  });
});
