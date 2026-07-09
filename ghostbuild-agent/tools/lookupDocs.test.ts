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

  it('rejects removed aliases', () => {
    expect(lookupDocsParameters.safeParse({ docs: ['agents'] }).success).toBe(false);
  });
});
