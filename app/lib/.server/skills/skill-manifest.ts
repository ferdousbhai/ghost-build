import { z } from 'zod';
import { CLOUDFLARE_SKILL_SOURCE } from './skill-sources';

const sha1 = z.string().regex(/^[0-9a-f]{40}$/);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const activeSkillManifestSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.object({
    id: z.literal(CLOUDFLARE_SKILL_SOURCE.id),
    repository: z.literal(CLOUDFLARE_SKILL_SOURCE.repository),
    treeSha: sha1,
  }),
  activatedAt: z.number().int().nonnegative(),
  skills: z.record(
    z.string(),
    z.object({
      storageKey: z.string().startsWith('system/skills/blobs/').max(200),
      contentSha256: sha256,
      upstreamBlobSha: sha1,
    }),
  ),
});

export type ActiveSkillManifest = z.infer<typeof activeSkillManifestSchema>;
