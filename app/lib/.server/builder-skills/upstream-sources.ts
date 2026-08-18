export type SkillSource = {
  id: string;
  repository: string;
  defaultBranch: string;
  publishedRevision: string;
  skills: readonly string[];
  discovery?: {
    root: string;
    entrypoint: string;
    excludedSkillNames: readonly string[];
  };
};

/** Official upstream Agent Skill trees mirrored unchanged into Ghostbuild's R2 skill bucket. */
export const BUILDER_SKILL_SOURCES: readonly SkillSource[] = [
  {
    id: 'cloudflare-skills',
    repository: 'cloudflare/skills',
    defaultBranch: 'main',
    publishedRevision: 'f96bff754e428838818017f75817f0f9428acd48',
    skills: ['skills/cloudflare', 'skills/agents-sdk', 'skills/workers-best-practices', 'skills/wrangler'],
    discovery: {
      root: 'skills',
      entrypoint: 'SKILL.md',
      // These skills existed when automatic discovery was enabled and were deliberately not selected.
      // Excluding by frontmatter name survives directory-only renames. A simultaneous path and identity rename is
      // intentionally treated as a new skill and reviewed by the same validation used for any new publication.
      excludedSkillNames: [
        'cloudflare-email-service',
        'cloudflare-one',
        'cloudflare-one-migrations',
        'durable-objects',
        'sandbox-migrate-to-next',
        'sandbox-next',
        'sandbox-stable',
        'turnstile-spin',
        'web-perf',
      ],
    },
  },
  {
    id: 'tanstack-router',
    repository: 'TanStack/router',
    defaultBranch: 'main',
    publishedRevision: '38485038c52ff898777cabeeeb2eaaa29c93f789',
    skills: ['packages/react-start/skills/react-start'],
  },
  {
    id: 'tanstack-db',
    repository: 'TanStack/db',
    defaultBranch: 'main',
    publishedRevision: '9005885bfe5f8ac4e6d68c35b66dedaa9a27cc2f',
    skills: ['packages/db/skills/db-core', 'packages/react-db/skills/react-db'],
  },
  {
    id: 'anthropic-skills',
    repository: 'anthropics/skills',
    defaultBranch: 'main',
    publishedRevision: 'f17010c9bb483898c1d9c9f42dde2b3a98889434',
    skills: ['skills/frontend-design'],
  },
];
