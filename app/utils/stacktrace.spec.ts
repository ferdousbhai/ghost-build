import { describe, expect, it } from 'vitest';
import { cleanStackTrace } from './stacktrace';

describe('cleanStackTrace', () => {
  it('replaces WebContainer URLs with relative paths', () => {
    expect(
      cleanStackTrace(
        'at https://abc.local-credentialless.webcontainer-api.io/src/App.tsx:4:2\nat https://example.com/app.js',
      ),
    ).toBe('at src/App.tsx:4:2\nat https://example.com/app.js');
  });

  it('stops URL replacement at closing parentheses', () => {
    expect(cleanStackTrace('(https://abc.local-credentialless.webcontainer-api.io/src/main.tsx:1:1)')).toBe(
      '(src/main.tsx:1:1)',
    );
  });
});
