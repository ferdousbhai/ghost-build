import { describe, expect, it } from 'vitest';
import { WORK_DIR } from 'ghostbuild-agent/constants';
import { assertNotLocalSecretFilePath, isLocalSecretFilePath } from './secretFiles';

describe('local secret file paths', () => {
  it('blocks local env and dev vars files', () => {
    expect(isLocalSecretFilePath('.env')).toBe(true);
    expect(isLocalSecretFilePath('.env.local')).toBe(true);
    expect(isLocalSecretFilePath(`${WORK_DIR}/.dev.vars`)).toBe(true);
    expect(isLocalSecretFilePath('nested/.dev.vars.production')).toBe(true);
    expect(isLocalSecretFilePath('nested/.envrc')).toBe(true);
    expect(isLocalSecretFilePath(`${WORK_DIR}/nested/.env.production`)).toBe(true);
    expect(isLocalSecretFilePath(`${WORK_DIR}/nested/.dev.vars.production`)).toBe(true);
    expect(isLocalSecretFilePath('nested\\.env.local')).toBe(true);
  });

  it('allows ordinary project files', () => {
    expect(isLocalSecretFilePath('wrangler.jsonc')).toBe(false);
    expect(isLocalSecretFilePath(`${WORK_DIR}/src/server.ts`)).toBe(false);
  });

  it('throws with Cloudflare binding guidance', () => {
    expect(() => assertNotLocalSecretFilePath('.env.local')).toThrow(
      /Use Cloudflare Worker bindings or wrangler secret put NAME/,
    );
  });
});
