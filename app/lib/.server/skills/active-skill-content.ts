import type { DocKey } from 'ghostbuild-agent/tools/lookupDocs';
import { activeSkillManifestSchema } from './skill-manifest';
import { sha256Hex, validateUpstreamSkillContent } from './skill-content';
import { ACTIVE_SKILL_MANIFEST_KEY, upstreamCloudflareSkills } from './skill-sources';

const MAX_MANIFEST_BYTES = 64 * 1024;

export async function loadActiveUpstreamSkills(
  env: Pick<Env, 'APP_STORAGE'>,
  requested: readonly DocKey[],
): Promise<Partial<Record<DocKey, string>>> {
  try {
    const object = await env.APP_STORAGE.get(ACTIVE_SKILL_MANIFEST_KEY);
    if (!object || object.size > MAX_MANIFEST_BYTES) {
      return {};
    }
    const manifest = activeSkillManifestSchema.parse(await object.json());
    const selected = await Promise.all(
      requested.map(async (docKey): Promise<[DocKey, string] | undefined> => {
        const source = upstreamCloudflareSkills.find((skill) => skill.docKey === docKey);
        const entry = manifest.skills[docKey];
        if (!source || !entry) {
          return undefined;
        }
        try {
          const skill = await env.APP_STORAGE.get(entry.storageKey);
          if (!skill || skill.size > 256 * 1024) {
            return undefined;
          }
          const bytes = await skill.arrayBuffer();
          if ((await sha256Hex(bytes)) !== entry.contentSha256) {
            return undefined;
          }
          const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
          validateUpstreamSkillContent(content, source.name);
          return [docKey, content];
        } catch (error) {
          console.error(`Failed to load synchronized upstream skill ${docKey}.`, error);
          return undefined;
        }
      }),
    );
    return Object.fromEntries(selected.filter((entry) => entry !== undefined));
  } catch (error) {
    console.error('Failed to load the active synchronized skill manifest.', error);
    return {};
  }
}
