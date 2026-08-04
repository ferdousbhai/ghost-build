import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  CLOUDFLARE_ABUSE_URL,
  GHOSTBUILD_ABUSE_URL,
  GHOSTBUILD_SECURITY_URL,
  GHOSTBUILD_SUPPORT_URL,
  TRUST_CHANNEL_STATUS,
  TRUST_LINKS,
} from './trust';

describe('public trust contract', () => {
  it('keeps public support and abuse separate from private vulnerability reporting', () => {
    expect(new Set([GHOSTBUILD_SUPPORT_URL, GHOSTBUILD_ABUSE_URL, GHOSTBUILD_SECURITY_URL]).size).toBe(3);
    expect(GHOSTBUILD_SUPPORT_URL).toContain('support_request.yml');
    expect(GHOSTBUILD_ABUSE_URL).toContain('abuse_report.yml');
    expect(GHOSTBUILD_SECURITY_URL).toContain('/security/advisories/new');
  });

  it('states targets without claiming continuous monitoring or a service level', () => {
    expect(TRUST_CHANNEL_STATUS).toContain('aims to');
    expect(TRUST_CHANNEL_STATUS).toContain('not guarantees');
    expect(TRUST_CHANNEL_STATUS).toContain('not monitored continuously');
    expect(TRUST_CHANNEL_STATUS).toContain('does not provide 24/7');
  });

  it('keeps the public issue forms explicit about sensitive data and emergencies', () => {
    const support = issueForm('.github/ISSUE_TEMPLATE/support_request.yml');
    const abuse = issueForm('.github/ISSUE_TEMPLATE/abuse_report.yml');

    expect(support.introduction).toContain('This issue is public');
    expect(support.introduction).toContain('Do not include');
    expect(support.introduction).toContain('do not provide sensitive information');
    expect(support.introduction).toContain('local emergency services');
    expect(support.assignees).toEqual(['ferdousbhai']);
    expect(abuse.introduction).toContain('This issue is public');
    expect(abuse.introduction).toContain('Do not download, copy, or attach suspected illegal imagery');
    expect(abuse.introduction).toContain(CLOUDFLARE_ABUSE_URL);
    expect(abuse.introduction).toContain('local emergency services');
    expect(abuse.assignees).toEqual(['ferdousbhai']);
  });

  it('publishes every trust route in the sitemap', () => {
    const sitemap = readFileSync('public/sitemap.xml', 'utf8');
    for (const { href } of TRUST_LINKS) {
      expect(sitemap).toContain(`<loc>https://ghostbuild.dev${href}</loc>`);
    }
  });

  it('publishes the standard vulnerability-discovery file', () => {
    const securityTxt = readFileSync('public/.well-known/security.txt', 'utf8');
    expect(securityTxt).toContain(`Contact: ${GHOSTBUILD_SECURITY_URL}`);
    expect(securityTxt).toContain('Canonical: https://ghostbuild.dev/.well-known/security.txt');
    expect(securityTxt).toContain('Policy: https://ghostbuild.dev/security');
    expect(securityTxt).toContain('Preferred-Languages: en');
  });
});

function issueForm(path: string): { assignees: string[]; introduction: string } {
  const form = parse(readFileSync(path, 'utf8')) as {
    assignees?: string[];
    body?: Array<{ type?: string; attributes?: { value?: string } }>;
  };
  const introduction = form.body?.find((item) => item.type === 'markdown')?.attributes?.value;
  expect(introduction).toBeTypeOf('string');
  return { assignees: form.assignees ?? [], introduction: introduction ?? '' };
}
