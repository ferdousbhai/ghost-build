import { describe, expect, it } from 'vitest';
import { docDescriptions, docKeys, docs } from '../references/index.js';
import { lookupDocsParameters } from './lookupDocs.js';

describe('lookupDocs tool parameters', () => {
  it('accepts canonical reference keys', () => {
    expect(
      lookupDocsParameters.parse({
        docs: ['cloudflareAgentsSdk', 'frontendDesign', 'wrangler'],
      }),
    ).toEqual({
      docs: ['cloudflareAgentsSdk', 'frontendDesign', 'wrangler'],
    });
  });

  it('keeps catalog keys aligned with content and descriptions', () => {
    expect(Object.keys(docs)).toEqual([...docKeys]);
    expect(Object.keys(docDescriptions)).toEqual([...docKeys]);
  });

  it('uses the Cloudflare platform skill to distinguish apps from focused Workers', () => {
    expect(docs.cloudflarePlatform).toContain('github.com/cloudflare/skills/tree/main/skills/cloudflare');
    expect(docs.cloudflarePlatform).toContain('a direct Worker handler without an application framework');
    expect(docs.cloudflarePlatform).toContain('Worker scheduled handler with Cron Triggers');
  });

  it('keeps generated Cloudflare data access behind the reviewed binding broker', () => {
    expect(docs.cloudflareStorage).toContain('getAppBindings() from "@/app-bindings"');
    expect(docs.cloudflareStorage).toContain(
      'AI, AppAgent, and AGENT_SECURITY_DB bindings are intentionally\n  unavailable to generated routes',
    );
    expect(docs.tanstackStart).toContain('Do not import "cloudflare:workers"');
  });

  it('rejects removed aliases', () => {
    expect(lookupDocsParameters.safeParse({ docs: ['agents'] }).success).toBe(false);
  });
});
