import { describe, expect, it } from 'vitest';
import { systemPrompt } from './system.js';

describe('Ghostbuild system prompt', () => {
  it('contains product constraints, the current lifecycle rule, and the live skill catalog', () => {
    const prompt = systemPrompt('cloudflare-app-builder: Owner-published builder guidance.');

    expect(prompt).toContain("user's connected Cloudflare account");
    expect(prompt).toContain('/home/project');
    expect(prompt).toContain('pnpm run validate');
    expect(prompt).toContain('activate the cloudflare-app-builder skill');
    expect(prompt).toContain('owner-published references');
    expect(prompt).toContain('cloudflare-app-builder: Owner-published builder guidance.');
    expect(prompt).not.toContain('Cloudflare platform:');
    expect(prompt.length).toBeLessThan(1_000);
  });
});
