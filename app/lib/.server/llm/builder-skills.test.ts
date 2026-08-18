import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createBuilderSkillContext, isBuilderSkillPath, PROJECT_SKILL_POINTERS } from './builder-skills';

describe('builder skills', () => {
  it('catalogs the bundled skill using its own frontmatter', () => {
    const { prompt } = createBuilderSkillContext();

    expect(prompt).toContain('/__skills__/frontend-design/SKILL.md — Visual design for new or reworked UI');
    expect(prompt).toContain(PROJECT_SKILL_POINTERS[0].path);
    expect(prompt).toContain('never fetch llms.txt or llms-full.txt');
  });

  it('serves the bundled skill through the read tool namespace', async () => {
    const { reader } = createBuilderSkillContext();

    await expect(reader.read('/__skills__/frontend-design/SKILL.md')).resolves.toEqual({
      kind: 'file',
      content: expect.stringContaining('name: frontend-design'),
    });
    await expect(reader.read('/__skills__/frontend-design')).resolves.toEqual({
      kind: 'directory',
      content: 'SKILL.md',
    });
    await expect(reader.read('/__skills__/frontend-design/LICENSE.txt')).resolves.toBeNull();
    await expect(reader.read('/__skills__/nothing/SKILL.md')).resolves.toBeNull();
    // The overlay is not a traversal into the project workspace.
    await expect(reader.read('/__skills__/../home/project/package.json')).resolves.toBeNull();
  });

  it('recognises the overlay namespace and nothing outside it', () => {
    expect(isBuilderSkillPath('/__skills__')).toBe(true);
    expect(isBuilderSkillPath('/__skills__/frontend-design/SKILL.md')).toBe(true);
    expect(isBuilderSkillPath('/home/project/__skills__/SKILL.md')).toBe(false);
  });

  it('points only at framework skills the template actually installs', () => {
    // These paths are read from the running container, so a package that moves or drops its
    // skills would leave the catalog advertising a file the model cannot open.
    for (const { path } of PROJECT_SKILL_POINTERS) {
      const installed = resolve(process.cwd(), 'template', path.replace('/home/project/', ''));
      expect(existsSync(installed), `${path} is not installed in template/node_modules`).toBe(true);
    }
  });
});
