import { describe, expect, it } from 'vitest';
import { toolFailure, toolResultContent, toolResultSucceeded, toolSuccess } from './tool-result.js';

describe('toolResultContent', () => {
  it('returns string content from a structured tool result', () => {
    expect(toolResultContent(toolSuccess('Viewed file', { content: 'const answer = 42;' }))).toBe('const answer = 42;');
  });

  it('ignores unstructured and non-string content', () => {
    expect(toolResultContent('plain result')).toBeUndefined();
    expect(toolResultContent(toolFailure('No content', { content: { error: true } }))).toBeUndefined();
  });
});

describe('toolResultSucceeded', () => {
  it('does not infer failure from legacy Error-prefixed strings', () => {
    expect(toolResultSucceeded('Error: plain model-visible text')).toBe(true);
    expect(toolResultSucceeded(toolFailure('Structured failure'))).toBe(false);
  });
});
