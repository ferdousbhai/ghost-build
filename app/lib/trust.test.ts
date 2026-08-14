import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  GHOSTBUILD_OPERATOR,
  GHOSTBUILD_SECURITY_URL,
  GHOSTBUILD_SUPPORT_URL,
  TRUST_CHANNEL_STATUS,
  TRUST_LINKS,
} from './trust';

describe('public trust contract', () => {
  it('identifies the accountable public-beta operator without private tax identifiers', () => {
    expect(GHOSTBUILD_OPERATOR).toEqual({
      legalName: 'DOUS SOFTWARE INC.',
      legalForm: 'Ontario corporation',
      registrationNumber: '1001622428',
      correspondenceAddress: '350 Bay Street, Suite 1300B, Toronto, Ontario M5H 2S6, Canada',
    });
  });

  it('keeps public support separate from private vulnerability reporting', () => {
    expect(GHOSTBUILD_SUPPORT_URL).not.toBe(GHOSTBUILD_SECURITY_URL);
    expect(GHOSTBUILD_SUPPORT_URL).toContain('support_request.yml');
    expect(GHOSTBUILD_SECURITY_URL).toContain('/security/advisories/new');
  });

  it('states targets without claiming continuous monitoring or a service level', () => {
    expect(TRUST_CHANNEL_STATUS).toContain('aims to');
    expect(TRUST_CHANNEL_STATUS).toContain('not guarantees');
    expect(TRUST_CHANNEL_STATUS).toContain('not monitored continuously');
    expect(TRUST_CHANNEL_STATUS).toContain('does not provide 24/7');
  });

  it('keeps operator storage distinct from user-owned project data', () => {
    const privacy = readFileSync('app/routes/privacy.tsx', 'utf8');
    expect(privacy).toContain('control-plane database does not store prompt or transcript bodies');
    expect(privacy).toContain('remain in the connected Cloudflare account');
    expect(privacy).toContain('browser may keep account-local');
    expect(privacy).toContain('skip AI Gateway caching and log collection');
  });

  it('keeps the public issue forms explicit about sensitive data and emergencies', () => {
    const support = issueForm('.github/ISSUE_TEMPLATE/support_request.yml');

    expect(support.introduction).toContain('This issue is public');
    expect(support.introduction).toContain('Do not include');
    expect(support.introduction).toContain('do not provide sensitive information');
    expect(support.introduction).toContain('local emergency services');
    expect(support.assignees).toEqual(['ferdousbhai']);
  });

  it('publishes every trust route in the sitemap', () => {
    const sitemap = readFileSync('public/sitemap.xml', 'utf8');
    for (const { href } of TRUST_LINKS) {
      expect(sitemap).toContain(`<loc>https://ghostbuild.dev${href}</loc>`);
    }
  });

  it('publishes the standard vulnerability-discovery file', () => {
    const securityTxt = readFileSync('public/.well-known/security.txt', 'utf8');
    const staticHeaders = readFileSync('public/_headers', 'utf8');
    expect(securityTxt).toContain(`Contact: ${GHOSTBUILD_SECURITY_URL}`);
    expect(securityTxt).toContain('Canonical: https://ghostbuild.dev/.well-known/security.txt');
    expect(securityTxt).toContain('Policy: https://ghostbuild.dev/security');
    expect(securityTxt).toContain('Preferred-Languages: en');
    expect(staticHeaders).toContain('/.well-known/security.txt');
    expect(staticHeaders).toContain('Content-Type: text/plain; charset=utf-8');
  });

  it('keeps private vulnerability reporting as the only documented security-report path', () => {
    const policy = readFileSync('SECURITY.md', 'utf8');
    const issueConfig = parse(readFileSync('.github/ISSUE_TEMPLATE/config.yml', 'utf8')) as {
      blank_issues_enabled?: boolean;
      contact_links?: Array<{ name?: string; url?: string }>;
    };

    expect(policy).toContain(GHOSTBUILD_SECURITY_URL);
    expect(policy).not.toContain('open a public issue containing no vulnerability details');
    expect(issueConfig.blank_issues_enabled).toBe(false);
    expect(issueConfig.contact_links?.find((link) => link.name === 'Report a security vulnerability')?.url).toBe(
      GHOSTBUILD_SECURITY_URL,
    );
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
