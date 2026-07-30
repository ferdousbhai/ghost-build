import type { DocKey } from 'ghostbuild-agent/tools/lookupDocs';

export const CLOUDFLARE_SKILL_SOURCE = {
  id: 'cloudflare-skills',
  repository: 'cloudflare/skills',
  branch: 'main',
} as const;

export type UpstreamSkillSource = {
  docKey: DocKey;
  name: string;
  path: `skills/${string}/SKILL.md`;
};

export const upstreamCloudflareSkills = [
  {
    docKey: 'cloudflarePlatform',
    name: 'cloudflare',
    path: 'skills/cloudflare/SKILL.md',
  },
  {
    docKey: 'cloudflareAgentsSdk',
    name: 'agents-sdk',
    path: 'skills/agents-sdk/SKILL.md',
  },
  {
    docKey: 'durableObjects',
    name: 'durable-objects',
    path: 'skills/durable-objects/SKILL.md',
  },
  {
    docKey: 'workersBestPractices',
    name: 'workers-best-practices',
    path: 'skills/workers-best-practices/SKILL.md',
  },
  {
    docKey: 'wrangler',
    name: 'wrangler',
    path: 'skills/wrangler/SKILL.md',
  },
  {
    docKey: 'cloudflareEmailService',
    name: 'cloudflare-email-service',
    path: 'skills/cloudflare-email-service/SKILL.md',
  },
  {
    docKey: 'cloudflareSandboxSdk',
    name: 'sandbox-sdk',
    path: 'skills/sandbox-sdk/SKILL.md',
  },
  {
    docKey: 'cloudflareTurnstile',
    name: 'turnstile-spin',
    path: 'skills/turnstile-spin/SKILL.md',
  },
  {
    docKey: 'webPerf',
    name: 'web-perf',
    path: 'skills/web-perf/SKILL.md',
  },
] as const satisfies readonly UpstreamSkillSource[];

export type UpstreamCloudflareDocKey = (typeof upstreamCloudflareSkills)[number]['docKey'];

export const ACTIVE_SKILL_MANIFEST_KEY = 'system/skills/active.json';
export const SKILL_BLOB_PREFIX = 'system/skills/blobs/';
export const SKILL_RELEASE_PREFIX = 'system/skills/releases/';
