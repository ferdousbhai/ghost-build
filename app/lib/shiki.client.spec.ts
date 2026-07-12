import { describe, expect, it } from 'vitest';
import { getCodeHighlighter, normalizeCodeLanguage } from './shiki.client';

describe('normalizeCodeLanguage', () => {
  it.each([
    ['.ts', 'typescript'],
    ['JS', 'javascript'],
    ['shell', 'bash'],
    ['yml', 'yaml'],
    ['unknown', 'plaintext'],
  ] as const)('normalizes %s to %s', (input, expected) => {
    expect(normalizeCodeLanguage(input)).toBe(expected);
  });

  it.each(['c', 'c++', 'cpp', 'csharp', 'java', 'swift'])('falls back to plaintext for %s', (language) => {
    expect(normalizeCodeLanguage(language)).toBe('plaintext');
  });
});

describe('getCodeHighlighter', () => {
  it('renders unsupported languages as plaintext', async () => {
    const highlighter = await getCodeHighlighter({ langs: [], themes: ['dark-plus'] });
    const html = highlighter.codeToHtml('int main() { return 0; }', {
      lang: normalizeCodeLanguage('cpp'),
      theme: 'dark-plus',
    });

    expect(html).toContain('int main() { return 0; }');
    expect(highlighter.getLoadedLanguages()).not.toContain('cpp');
  });

  it('loads supported languages on demand', async () => {
    const highlighter = await getCodeHighlighter({ langs: [], themes: ['dark-plus'] });

    expect(highlighter.getLoadedLanguages()).not.toContain('typescript');

    await getCodeHighlighter({ langs: ['typescript'], themes: ['dark-plus'] });

    expect(highlighter.getLoadedLanguages()).toContain('typescript');
    expect(highlighter.codeToHtml('const answer: number = 42', { lang: 'typescript', theme: 'dark-plus' })).toContain(
      '<span',
    );
  });
});
