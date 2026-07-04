import { describe, expect, it } from 'vitest';
import { assertProductionShellCommandAllowed, findForbiddenProductionShellCommand } from './productionShellPolicy';

describe('production shell policy', () => {
  it('allows production deploy and build commands', () => {
    expect(findForbiddenProductionShellCommand('pnpm run deploy')).toBeUndefined();
    expect(findForbiddenProductionShellCommand('pnpm run deploy:production')).toBeUndefined();
    expect(findForbiddenProductionShellCommand('pnpm run build')).toBeUndefined();
    expect(findForbiddenProductionShellCommand('pnpm exec vite build')).toBeUndefined();
    expect(findForbiddenProductionShellCommand('pnpm wrangler deploy')).toBeUndefined();
  });

  it('blocks local dev-server commands', () => {
    expect(findForbiddenProductionShellCommand('pnpm run dev')?.reason).toBe('start a local package script');
    expect(findForbiddenProductionShellCommand('npm run preview')?.reason).toBe('start a local package script');
    expect(findForbiddenProductionShellCommand('wrangler dev')?.reason).toBe('start Wrangler dev');
    expect(findForbiddenProductionShellCommand('pnpm exec vite')?.reason).toBe(
      'start Vite dev through a package executor',
    );
    expect(findForbiddenProductionShellCommand('pnpm vite')?.reason).toBe('start Vite dev through a package executor');
    expect(findForbiddenProductionShellCommand('npx vite')?.reason).toBe('start Vite dev through a package executor');
    expect(findForbiddenProductionShellCommand('vite --host 0.0.0.0')?.reason).toBe('start Vite dev');
  });

  it('blocks staging commands', () => {
    expect(() => assertProductionShellCommandAllowed('pnpm run deploy:staging')).toThrow(
      /Deploy directly to the production Cloudflare Worker/,
    );
  });
});
