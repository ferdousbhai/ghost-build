import { describe, expect, it } from 'vitest';
import type { Tool } from 'ai';
import { BUILDER_SKILL_NAME, createBuilderSkillContext } from './builder-skills';

const systemDocs = {
  version: 1 as const,
  documents: [
    {
      id: 'workers-ai',
      description: 'Workers AI binding guidance.',
      content: '# Workers AI\n\nUse the AI binding.',
    },
  ],
};

describe('builder skills', () => {
  it('exposes owner guidance through the official Agent Skills tools', async () => {
    const context = await createBuilderSkillContext(systemDocs);

    expect(context.catalogPrompt).toContain(`${BUILDER_SKILL_NAME}:`);
    const activated = await execute(context.tools.activate_skill, { name: BUILDER_SKILL_NAME });
    expect(activated).toContain('references/workers-ai.md — Workers AI binding guidance.');
    expect(activated).toContain('<file kind="reference"');

    const resource = await execute(context.tools.read_skill_resource, {
      name: BUILDER_SKILL_NAME,
      path: 'references/workers-ai.md',
    });
    expect(resource).toContain('# Workers AI');
  });
});

async function execute(tool: Tool | undefined, input: unknown): Promise<string> {
  if (!tool?.execute) {
    throw new Error('Expected an executable skill tool.');
  }
  return String(await tool.execute(input as never, { toolCallId: 'skill-test', messages: [] } as never));
}
