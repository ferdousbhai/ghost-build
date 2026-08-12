import { SkillRegistry, fromManifest, type SkillManifest, type SkillManifestResource } from 'agents/skills';
import type { ToolSet } from 'ai';
import type { SystemDocsBundle } from 'ghostbuild-agent/system-docs';

export const BUILDER_SKILL_NAME = 'cloudflare-app-builder';

type BuilderSkillContext = {
  catalogPrompt: string;
  tools: ToolSet;
};

/** Present owner-published guidance through the official Agent Skills runtime. */
export async function createBuilderSkillContext(systemDocs: SystemDocsBundle): Promise<BuilderSkillContext> {
  const registry = new SkillRegistry([fromManifest(await systemDocsSkillManifest(systemDocs))]);
  const catalogPrompt = await registry.systemPrompt();
  if (!catalogPrompt || registry.warnings.length > 0) {
    throw new Error(registry.warnings.join('; ') || 'Owner-published builder guidance did not expose a skill.');
  }
  return { catalogPrompt, tools: registry.tools() };
}

async function systemDocsSkillManifest(systemDocs: SystemDocsBundle): Promise<SkillManifest> {
  const resources: SkillManifestResource[] = systemDocs.documents.map((document) => ({
    path: `references/${document.id}.md`,
    kind: 'reference',
    encoding: 'text',
    mimeType: 'text/markdown',
    size: new TextEncoder().encode(document.content).byteLength,
    content: document.content,
  }));
  const fingerprint = await sha256(
    JSON.stringify(systemDocs.documents.map(({ id, description, content }) => ({ id, description, content }))),
  );
  return {
    id: 'ghostbuild-owner-guidance',
    fingerprint,
    skills: [
      {
        name: BUILDER_SKILL_NAME,
        description:
          'Owner-published Cloudflare, TanStack, and frontend guidance for building Ghostbuild applications.',
        body: [
          'Use the relevant bundled references before choosing platform APIs, framework patterns, or interface behavior.',
          'Read only the references needed for the current task with read_skill_resource.',
          '',
          ...systemDocs.documents.map(({ id, description }) => `- references/${id}.md — ${description}`),
        ].join('\n'),
        resources,
      },
    ],
  };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
