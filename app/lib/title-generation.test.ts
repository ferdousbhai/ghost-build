import { describe, expect, it } from 'vitest';
import {
  MAX_GENERATED_TITLE_CHARACTERS,
  deriveProvisionalTitle,
  generateTitle,
  normalizeGeneratedTitle,
  shouldGenerateConversationTitle,
} from './title-generation';

describe('title generation', () => {
  it('derives useful provisional titles', () => {
    expect(deriveProvisionalTitle('Build a polished app called Pocket Poll, with live voting.')).toBe('Pocket Poll');
    expect(deriveProvisionalTitle('Can you please get the weather?')).toBe('weather');
  });

  it('generates on the first prompt and substantial later prompts', () => {
    expect(shouldGenerateConversationTitle('short prompt', 1)).toBe(true);
    expect(shouldGenerateConversationTitle('short prompt', 2)).toBe(false);
    expect(shouldGenerateConversationTitle('a'.repeat(64), 2)).toBe(false);
    expect(shouldGenerateConversationTitle('a'.repeat(65), 2)).toBe(true);
  });

  it('builds a subject-specific, bounded request', async () => {
    let request: { prompt: string; maxOutputTokens: number; temperature: number } | undefined;
    const generated = await generateTitle({
      execute: async (value) => {
        request = value;
        return { text: 'Feature Launch' };
      },
      prompt: 'Plan the feature launch',
      subject: 'conversation',
    });

    expect(generated?.title).toBe('Feature Launch');
    expect(request).toMatchObject({ maxOutputTokens: 24, temperature: 0 });
    expect(request?.prompt).toContain('title for this conversation');
    expect(request?.prompt).toContain('untrusted data');
  });

  it('normalizes framing and rejects weak output', () => {
    expect(normalizeGeneratedTitle('"Title: Pocket Poll"')).toBe('Pocket Poll');
    expect(normalizeGeneratedTitle('\n## Project title: "Feature Launch."')).toBe('Feature Launch');
    expect(normalizeGeneratedTitle('New conversation')).toBeNull();
  });

  it('clamps by Unicode code points without splitting a surrogate pair', () => {
    const title = normalizeGeneratedTitle(`${'a'.repeat(59)}😀x`);
    expect(title).toBe(`${'a'.repeat(59)}😀`);
    expect(Array.from(title ?? '')).toHaveLength(MAX_GENERATED_TITLE_CHARACTERS);
    expect(title).not.toMatch(/[\uD800-\uDFFF]$/u);
  });
});
