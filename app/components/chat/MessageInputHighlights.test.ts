import { describe, expect, it } from 'vitest';
import { findHighlightBlocks, type MessageInputHighlight } from './MessageInputHighlights';

describe('findHighlightBlocks', () => {
  it('finds configured phrases without case sensitivity', () => {
    const highlights: MessageInputHighlight[] = [{ text: 'ai chat', tooltip: 'AI' }];
    expect(findHighlightBlocks('Build an AI Chat and ai chat', highlights)).toEqual([
      { from: 9, length: 7, tip: 'AI' },
      { from: 21, length: 7, tip: 'AI' },
    ]);
  });
});
