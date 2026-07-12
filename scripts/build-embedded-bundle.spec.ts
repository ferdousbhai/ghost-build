import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const shellSafeCommonJs = require('./shell-safe-commonjs.cjs') as (source: string) => string;

describe('embedded bundle builder', () => {
  it('encodes CommonJS source without shell-breaking single quotes', () => {
    const wrapped = shellSafeCommonJs(`module.exports = { message: "it's safe" };`);
    const cjsModule: { exports: unknown } = { exports: {} };

    expect(wrapped).not.toContain("'");
    Function(
      'require',
      'module',
      'exports',
      '__filename',
      '__dirname',
      wrapped,
    )(require, cjsModule, cjsModule.exports, '/tmp/bundle.cjs', '/tmp');
    expect(cjsModule.exports).toEqual({ message: "it's safe" });
  });
});
