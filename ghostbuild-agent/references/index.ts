import {
  cloudflareAgentsSdk,
  cloudflareEmailService,
  cloudflarePlatform,
  cloudflareSandboxSdk,
  cloudflareStorage,
  cloudflareTurnstile,
  durableObjects,
  webPerf,
  workersAi,
  workersBestPractices,
  wrangler,
} from './cloudflare.js';
import { frontendDesign } from './frontendDesign.js';
import { tanstackDb, tanstackQuery, tanstackStart } from './tanstack.js';

type DocCatalogEntry = {
  description: string;
  content: string;
};

const docCatalog = {
  tanstackStart: {
    description: 'TanStack Start on Cloudflare app structure, routes, server functions, and typegen.',
    content: tanstackStart,
  },
  tanstackQuery: {
    description: 'TanStack Query client setup, queries, mutations, and invalidation.',
    content: tanstackQuery,
  },
  tanstackDb: {
    description: 'TanStack DB collections, live queries, and persisted collection writes.',
    content: tanstackDb,
  },
  cloudflarePlatform: {
    description:
      'Official Cloudflare platform skill guidance for product selection and retrieval-first Cloudflare work.',
    content: cloudflarePlatform,
  },
  workersAi: {
    description: 'Workers AI binding and Ghostbuild default model guidance.',
    content: workersAi,
  },
  cloudflareAgentsSdk: {
    description:
      'Official Cloudflare Agents SDK skill guidance for AIChatAgent, Agent classes, state, routing, and MCP.',
    content: cloudflareAgentsSdk,
  },
  durableObjects: {
    description:
      'Official Durable Objects skill guidance for stateful coordination, SQLite storage, alarms, and WebSockets.',
    content: durableObjects,
  },
  cloudflareStorage: {
    description: 'Cloudflare D1, R2, KV, Queues, and Vectorize selection guidance.',
    content: cloudflareStorage,
  },
  workersBestPractices: {
    description:
      'Official Workers best-practices skill guidance for Workers code, bindings, secrets, streaming, and observability.',
    content: workersBestPractices,
  },
  wrangler: {
    description: 'Official Wrangler skill guidance for wrangler.jsonc, bindings, deploy/dev/typegen, and CLI usage.',
    content: wrangler,
  },
  cloudflareEmailService: {
    description:
      'Official Cloudflare Email Service skill guidance for transactional sending, routing, and Agent email flows.',
    content: cloudflareEmailService,
  },
  cloudflareSandboxSdk: {
    description: 'Official Sandbox SDK skill guidance for secure code execution and AI code interpreters.',
    content: cloudflareSandboxSdk,
  },
  cloudflareTurnstile: {
    description: 'Official Turnstile skill guidance for CAPTCHA, bot protection, widgets, and siteverify.',
    content: cloudflareTurnstile,
  },
  webPerf: {
    description:
      'Official web performance skill guidance for Core Web Vitals, Lighthouse, layout shifts, and network cost.',
    content: webPerf,
  },
  frontendDesign: {
    description:
      'Front-end design skill guidance for high-quality UI, controls, layout, motion, and responsive polish.',
    content: frontendDesign,
  },
} as const satisfies Record<string, DocCatalogEntry>;

export type DocKey = keyof typeof docCatalog;

export const docKeys = Object.keys(docCatalog) as [DocKey, ...DocKey[]];

function mapDocCatalog<T>(getValue: (entry: DocCatalogEntry) => T): Record<DocKey, T> {
  return Object.fromEntries(docKeys.map((key) => [key, getValue(docCatalog[key])])) as Record<DocKey, T>;
}

export const docDescriptions = mapDocCatalog((entry) => entry.description);

export const docs = mapDocCatalog((entry) => entry.content);
