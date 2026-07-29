import { describe, expect, it } from 'vitest';
import { ROLE_SYSTEM_PROMPT } from './system.js';
import { solutionConstraints } from './solutionConstraints.js';

describe('Ghostbuild framework selection policy', () => {
  it('keeps the deployment-tested compatibility date pinned', () => {
    const prompt = solutionConstraints();

    expect(prompt).toContain('Never change that value');
    expect(prompt).toMatch(/Ghostbuild updates\s+the pinned date centrally/);
  });

  it('defaults full web applications to TanStack Start without requiring it for every project', () => {
    const prompt = `${ROLE_SYSTEM_PROMPT}\n${solutionConstraints()}`;

    expect(prompt).toContain('default to TanStack Start when the user does not request a framework');
    expect(prompt).toMatch(/Do not force a web\s+framework/);
    expect(prompt).toContain('Choose the smallest Cloudflare-native execution surface that fits the request');
  });

  it('directs focused Cloudflare scripts to Worker handlers instead of fabricated browser UI', () => {
    const prompt = solutionConstraints();

    expect(prompt).toContain('Automatic production deployment currently supports fetch-handler Workers');
    expect(prompt).toMatch(/use the Worker\s+handler directly in src\/server\.ts/);
    expect(prompt).toMatch(/A Worker\s+may expose a small HTML response without becoming a TanStack app/);
    expect(prompt).toContain('package.json ghostbuild.projectType to "worker"');
    expect(prompt).toContain('Wrangler dry-run targeting dist/worker');
  });

  it('keeps generated data access behind the reviewed binding broker', () => {
    const prompt = solutionConstraints();

    expect(prompt).toContain('getAppBindings from @/app-bindings');
    expect(prompt).toContain('Do not import cloudflare:workers');
    expect(prompt).toMatch(/AI and AppAgent bindings are not\s+exposed to generated routes/);
  });

  it('keeps generated dependency notices current before build and deployment', () => {
    const prompt = solutionConstraints();

    expect(prompt).toContain('After changing production dependencies, run pnpm run licenses:generate');
    expect(prompt).toContain('public/THIRD_PARTY_LICENSES.txt');
  });
});
