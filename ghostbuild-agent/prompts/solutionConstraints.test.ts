import { describe, expect, it } from 'vitest';
import { ROLE_SYSTEM_PROMPT } from './system.js';
import { solutionConstraints } from './solutionConstraints.js';

describe('Ghostbuild framework selection policy', () => {
  it('defaults full web applications to TanStack Start without requiring it for every project', () => {
    const prompt = `${ROLE_SYSTEM_PROMPT}\n${solutionConstraints()}`;

    expect(prompt).toContain('default to TanStack Start when the user does not request a framework');
    expect(prompt).toMatch(/Do not force a web\s+framework/);
    expect(prompt).toContain('Choose the smallest Cloudflare-native execution surface that fits the request');
  });

  it('directs focused Cloudflare scripts to Worker handlers instead of fabricated browser UI', () => {
    const prompt = solutionConstraints();

    expect(prompt).toContain('scheduled jobs, queue consumers, email handlers, Tail Workers');
    expect(prompt).toContain('use the appropriate Worker handler directly in src/server.ts');
    expect(prompt).toContain('A Worker may expose a small HTML response without becoming a TanStack app');
  });
});
