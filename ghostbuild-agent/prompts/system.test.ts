import { describe, expect, it } from 'vitest';
import { systemPrompt } from './system.js';

describe('Ghostbuild system prompt', () => {
  it('keeps only evergreen authority, safety, workflow, and skill-loading instructions', () => {
    const prompt = systemPrompt(
      '<builder_skills>\n- /__skills__/cloudflare/SKILL.md — Cloudflare guidance.\n</builder_skills>',
    );

    expect(prompt).toContain('/home/project');
    expect(prompt).toContain('project and its validation as the source of truth');
    expect(prompt).toContain('security and deployment boundaries');
    expect(prompt).toContain('keep secrets out');
    expect(prompt).toContain('project constraints take precedence');
    expect(prompt).toContain('read each relevant SKILL.md');
    expect(prompt).toContain('pnpm run validate');
    expect(prompt).toContain('/__skills__/cloudflare/SKILL.md');
    expect(prompt).not.toContain('activate_skill');
    expect(prompt).not.toContain('getAppBindings');
    expect(prompt).not.toContain('compatibility_date');
    expect(prompt).not.toContain('AGENT_SECURITY_DB');
    expect(prompt.length).toBeLessThan(1_000);
  });
});
