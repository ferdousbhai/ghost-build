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

    expect(support).toContain('This issue is public');
    expect(support).toContain('Do not include');
    expect(support).toContain('local emergency services');
    expect(abuse).toContain('This issue is public');
    expect(abuse).toContain('Do not download, copy, or attach suspected illegal imagery');
    expect(abuse).toContain(CLOUDFLARE_ABUSE_URL);
    expect(abuse).toContain('local emergency services');
  });

  it('publishes every trust route in the sitemap', () => {
    const sitemap = readFileSync('public/sitemap.xml', 'utf8');
    for (const { href } of TRUST_LINKS) {
      expect(sitemap).toContain(`<loc>https://ghostbuild.dev${href}</loc>`);
    }
  });
});

function issueForm(path: string): string {
  const form = parse(readFileSync(path, 'utf8')) as {
    body?: Array<{ type?: string; attributes?: { value?: string } }>;
  };
  const introduction = form.body?.find((item) => item.type === 'markdown')?.attributes?.value;
  expect(introduction).toBeTypeOf('string');
  return introduction ?? '';
}
