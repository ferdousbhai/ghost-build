import { describe, expect, test, vi } from 'vitest';
import {
  createPreviewPackageJson,
  createPreviewPackageLock,
  withPreviewPackageManifest,
} from './preview-package-manifest';

describe('WebContainer preview package manifest', () => {
  test('removes production-only packages while preserving UI and user dependencies', () => {
    const preview = JSON.parse(
      createPreviewPackageJson(
        JSON.stringify({
          name: 'generated-app',
          scripts: { dev: 'vite dev' },
          dependencies: {
            '@cloudflare/ai-chat': '1.0.0',
            '@tanstack/react-router': '1.0.0',
            '@tanstack/react-start': '1.0.0',
            ai: '1.0.0',
            'date-fns': '4.0.0',
            react: '19.0.0',
          },
          devDependencies: {
            '@cloudflare/vite-plugin': '1.0.0',
            '@vitejs/plugin-react': '1.0.0',
            typescript: '6.0.0',
            vite: '8.0.0',
          },
        }),
      ),
    );

    expect(preview).toMatchObject({
      name: 'generated-app',
      scripts: { dev: 'vite dev' },
      dependencies: {
        '@tanstack/react-router': '1.0.0',
        'date-fns': '4.0.0',
        react: '19.0.0',
      },
      devDependencies: {
        '@vitejs/plugin-react': '5.2.0',
        vite: '7.3.6',
      },
    });
    expect(preview.dependencies).not.toHaveProperty('@cloudflare/ai-chat');
    expect(preview.dependencies).not.toHaveProperty('@tanstack/react-start');
    expect(preview.dependencies).not.toHaveProperty('ai');
    expect(preview.devDependencies).not.toHaveProperty('@cloudflare/vite-plugin');
    expect(preview.devDependencies).not.toHaveProperty('typescript');
  });

  test('keeps the temporary lockfile root synchronized with the preview manifest', () => {
    const packageJson = JSON.stringify({
      name: 'generated-app',
      dependencies: {
        ai: '1.0.0',
        react: '19.0.0',
      },
      devDependencies: {
        typescript: '6.0.0',
        vite: '8.0.0',
      },
    });
    const previewLock = JSON.parse(
      createPreviewPackageLock(
        packageJson,
        JSON.stringify({
          name: 'generated-app',
          lockfileVersion: 3,
          packages: {
            '': {
              name: 'generated-app',
              dependencies: {
                ai: '1.0.0',
                react: '19.0.0',
              },
              devDependencies: {
                typescript: '6.0.0',
                vite: '8.0.0',
              },
            },
            'node_modules/react': { version: '19.0.0' },
          },
        }),
      ),
    );

    expect(previewLock.packages['']).toMatchObject({
      name: 'generated-app',
      dependencies: { react: '19.0.0' },
      devDependencies: { vite: '7.3.6' },
    });
    expect(previewLock.packages['']).not.toHaveProperty('dependencies.ai');
    expect(previewLock.packages['']).not.toHaveProperty('devDependencies.typescript');
    expect(previewLock.packages['node_modules/react']).toEqual({ version: '19.0.0' });
  });

  test('restores deployment manifests after installation', async () => {
    const files = new Map([
      ['package.json', '{"name":"complete","dependencies":{"ai":"1.0.0","react":"19.0.0"}}\n'],
      [
        'package-lock.json',
        '{"name":"complete","lockfileVersion":3,"packages":{"":{"dependencies":{"ai":"1.0.0","react":"19.0.0"}}}}\n',
      ],
    ]);
    const fs = {
      readFile: vi.fn(async (path: string) => {
        const content = files.get(path);
        if (content === undefined) {
          throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        }
        return content;
      }),
      writeFile: vi.fn(async (path: string, content: string) => {
        files.set(path, content);
      }),
      rm: vi.fn(async (path: string) => {
        files.delete(path);
      }),
    };

    await withPreviewPackageManifest({ fs } as never, files.get('package.json')!, async () => {
      expect(JSON.parse(files.get('package.json')!).dependencies).toEqual({ react: '19.0.0' });
      expect(JSON.parse(files.get('package-lock.json')!).packages[''].dependencies).toEqual({
        react: '19.0.0',
      });
      files.set('package-lock.json', '{"changed":true}\n');
    });

    expect(files.get('package.json')).toBe('{"name":"complete","dependencies":{"ai":"1.0.0","react":"19.0.0"}}\n');
    expect(files.get('package-lock.json')).toBe(
      '{"name":"complete","lockfileVersion":3,"packages":{"":{"dependencies":{"ai":"1.0.0","react":"19.0.0"}}}}\n',
    );
  });
});
