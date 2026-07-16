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

  it('rejects removed aliases', () => {
    expect(lookupDocsParameters.safeParse({ docs: ['agents'] }).success).toBe(false);
  });
});
