import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { BUILDER_SKILLS_POINTER_KEY, createBuilderSkillContext, isBuilderSkillPath } from './builder-skills';

const rawByName = (name: string) => `---\nname: ${name}\ndescription: ${name} guidance.\n---\nBody`;
const resourceByName = (name: string) => `${name} reference`;

vi.mock('agents/skills', () => ({
  r2: vi.fn((_bucket, options) => ({
    id: 'test',
    fingerprint: 'test',
    list: vi.fn(async () => [
      { name: 'cloudflare', description: 'Cloudflare guidance.' },
      { name: 'frontend-design', description: 'Frontend design guidance.' },
    ]),
    load: vi.fn(async (name: string) => ({
      name,
      description: `${name} guidance.`,
      body: 'Body',
      rawContent: rawByName(name),
      resources: [{ path: 'references/guide.md', kind: 'reference', encoding: 'text' }],
    })),
    readResource: vi.fn(async (name: string, path: string) => ({
      path,
      kind: 'reference',
      encoding: 'text',
      content: resourceByName(name),
    })),
    options,
  })),
  SkillRegistry: class {
    warnings: string[] = [];
    constructor(private sources: Array<{ list(): Promise<unknown[]> }>) {}
    async snapshot() {
      await this.sources[0]!.list();
      return { catalogPrompt: 'skills', fingerprint: 'test' };
    }
  },
}));

describe('builder skills', () => {
  it('loads exact upstream skills from an integrity-bound R2 generation', async () => {
    const fixture = publishedFixture();
    const bucket = r2Bucket(fixture);
    const context = await createBuilderSkillContext(bucket);

    expect(bucket.get).toHaveBeenCalledWith(BUILDER_SKILLS_POINTER_KEY);
    expect(context.prompt).toContain('/__skills__/cloudflare/SKILL.md — cloudflare guidance.');
    expect(context.prompt).toContain('/__skills__/frontend-design/SKILL.md — frontend-design guidance.');
    expect(await context.reader.read('/__skills__/cloudflare/SKILL.md')).toEqual({
      kind: 'file',
      content: expect.stringContaining('name: cloudflare'),
    });
    expect(await context.reader.read('/__skills__/cloudflare/references/')).toEqual({
      kind: 'directory',
      content: 'guide.md',
    });
    expect(await context.reader.read('/__skills__/cloudflare/references/guide.md')).toEqual({
      kind: 'file',
      content: 'cloudflare reference',
    });
    expect(await context.reader.read('/__skills__/unknown/SKILL.md')).toBeNull();
  });

  it('fails closed for malformed pointers and manifests', async () => {
    await expect(createBuilderSkillContext(r2Bucket(new Map([[BUILDER_SKILLS_POINTER_KEY, '{']])))).rejects.toThrow(
      'pointer is invalid',
    );
    const fixture = publishedFixture();
    fixture.set(
      BUILDER_SKILLS_POINTER_KEY,
      JSON.stringify({ ...JSON.parse(fixture.get(BUILDER_SKILLS_POINTER_KEY)!), skills: ['cloudflare'] }),
    );
    await expect(createBuilderSkillContext(r2Bucket(fixture))).rejects.toThrow('does not match its pointer');
  });

  it('reserves canonical and traversal-equivalent skill paths', () => {
    expect(isBuilderSkillPath('/__skills__/guide.md')).toBe(true);
    expect(isBuilderSkillPath('//__skills__//guide.md')).toBe(true);
    expect(isBuilderSkillPath('/home/project/../../../__skills__/guide.md')).toBe(true);
    expect(isBuilderSkillPath('/home/project/__skills__/guide.md')).toBe(false);
  });
});

function publishedFixture(): Map<string, string> {
  const skills = ['cloudflare', 'frontend-design'];
  const files = skills.flatMap((name) => [
    file(name, 'SKILL.md', rawByName(name)),
    file(name, 'references/guide.md', resourceByName(name)),
  ]);
  const generation = digest(
    files.map(({ name, path, sha256, size }) => `${name}\0${path}\0${sha256}\0${size}`).join('\n'),
  );
  return new Map([
    [BUILDER_SKILLS_POINTER_KEY, JSON.stringify({ version: 1, generation, skills })],
    [`generations/${generation}/manifest.json`, JSON.stringify({ version: 1, generation, files })],
  ]);
}

function file(name: string, path: string, content: string) {
  return { name, path, sha256: digest(content), size: Buffer.byteLength(content) };
}

function digest(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function r2Bucket(values: Map<string, string>): R2Bucket & { get: ReturnType<typeof vi.fn> } {
  return {
    get: vi.fn(async (key: string) => {
      const value = values.get(key);
      return value === undefined ? null : { size: Buffer.byteLength(value), text: async () => value };
    }),
  } as unknown as R2Bucket & { get: ReturnType<typeof vi.fn> };
}
