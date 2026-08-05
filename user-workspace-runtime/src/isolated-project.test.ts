import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  createContainerDirectoryCommand,
  createIsolatedProjectCommand,
  rebaseDeploymentConfigPaths,
  relativeIsolatedPath,
} from './isolated-project';

describe('isolated project command', () => {
  it('copies source without durable dependencies or build output', () => {
    const command = createIsolatedProjectCommand({
      projectRoot: '/home/project',
      isolatedRoot: '/tmp/ghostbuild-projects/validation-id',
      quote: (value) => `'${value}'`,
    });

    expect(command).toContain("tar -C '/home/project'");
    expect(command).toContain("--exclude='./node_modules'");
    expect(command).toContain("--exclude='./dist'");
    expect(command).toContain("--exclude='./.wrangler'");
    expect(command).not.toContain('ln -s');
    expect(command).toContain("'/tmp/ghostbuild-projects/validation-id'");
    expect(command).toContain("mkdir -p '/tmp/ghostbuild-projects/validation-id'");
    expect(command).toContain('Project source cannot contain non-regular files.');
  });

  it('rebases every trusted Wrangler project path into the isolated copy', () => {
    const config = rebaseDeploymentConfigPaths(
      {
        main: '/home/project/dist/server/index.js',
        assets: { directory: '/home/project/dist/client' },
        d1_databases: [
          { binding: 'DB', migrations_dir: '/home/project/migrations' },
          { binding: 'AGENT_SECURITY_DB', migrations_dir: '/home/project/agent-security-migrations' },
        ],
      },
      { projectRoot: '/home/project', isolatedRoot: '/tmp/ghostbuild-projects/deployment-id' },
    );

    expect(config).toEqual({
      main: '/tmp/ghostbuild-projects/deployment-id/dist/server/index.js',
      assets: { directory: '/tmp/ghostbuild-projects/deployment-id/dist/client' },
      d1_databases: [
        { binding: 'DB', migrations_dir: '/tmp/ghostbuild-projects/deployment-id/migrations' },
        {
          binding: 'AGENT_SECURITY_DB',
          migrations_dir: '/tmp/ghostbuild-projects/deployment-id/agent-security-migrations',
        },
      ],
    });
  });

  it('enters a quoted native directory from a valid workspace cwd', () => {
    expect(
      createContainerDirectoryCommand({
        directory: '/tmp/ghostbuild projects/validation-id',
        command: 'pnpm run build',
        quote: (value) => `'${value}'`,
      }),
    ).toBe("cd '/tmp/ghostbuild projects/validation-id' &&\npnpm run build");
  });

  it('rejects trusted deployment paths outside the durable project root', () => {
    expect(() =>
      rebaseDeploymentConfigPaths(
        { main: '/tmp/untrusted.js' },
        { projectRoot: '/home/project', isolatedRoot: '/tmp/ghostbuild-projects/deployment-id' },
      ),
    ).toThrow(/outside the project root/i);
  });

  it('derives artifact paths from the requested root, not transport metadata', () => {
    expect(
      relativeIsolatedPath(
        '/tmp/ghostbuild-projects/deployment-id/.ghostbuild-artifact',
        '/tmp/ghostbuild-projects/deployment-id/.ghostbuild-artifact/index.js',
      ),
    ).toBe('index.js');
    expect(() =>
      relativeIsolatedPath(
        '/tmp/ghostbuild-projects/deployment-id/.ghostbuild-artifact',
        '/tmp/ghostbuild-projects/deployment-id/elsewhere/index.js',
      ),
    ).toThrow(/outside its expected root/i);
  });

  it('runs validation, preview, and deployment builds outside the durable project', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const validation = source.slice(
      source.indexOf('async validateTool('),
      source.indexOf('async beginDeploymentSession('),
    );
    const preview = source.slice(source.indexOf('async createPreview('), source.indexOf('async stopPreview('));
    const deployment = source.slice(
      source.indexOf('async prepareDeploymentArtifact('),
      source.indexOf('async deleteProject('),
    );

    for (const operation of [validation, preview, deployment]) {
      expect(operation).toContain('createIsolatedProjectCommand');
      expect(operation).toContain('runNativeCommand');
      expect(operation).toContain('cwd: PROJECT_ROOT');
      expect(operation).not.toContain('removeDerivedFiles');
    }
    expect(deployment).toContain('rebaseDeploymentConfigPaths');
    expect(deployment).toContain('collectSandboxFiles(this, artifactRoot');
    expect(deployment).toContain('collectSandboxMigrations(this, `${isolatedRoot}/migrations`)');
    expect(preview).toContain("__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: '.trycloudflare.com,container'");
    expect(source).not.toContain("cwd: '/tmp'");
    expect(source).not.toContain('cwd: isolatedRoot');
    expect(source).not.toContain('cwd: snapshotRoot');
  });

  it('keeps the Computer container alive for stateful and deployment operations', () => {
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    const deployment = source.slice(
      source.indexOf('async prepareDeploymentArtifact('),
      source.indexOf('async deleteProject('),
    );
    const statefulOperation = source.slice(
      source.indexOf('private async withStatefulOperation'),
      source.indexOf('private requireCompletedComputerSync'),
    );
    const keepAlive = source.slice(
      source.indexOf('private async withContainerKeepAlive'),
      source.indexOf('private requireCompletedComputerSync'),
    );

    expect(deployment).toContain('return await this.withContainerKeepAlive(operation)');
    expect(statefulOperation).toContain('return await this.withContainerKeepAlive(operation)');
    expect(keepAlive).toContain('this.#containerKeepAliveOperations += 1');
    expect(keepAlive).toContain('await this.setKeepAlive(true)');
    expect(keepAlive).toContain('this.#containerKeepAliveOperations -= 1');
    expect(keepAlive).toContain('this.#containerKeepAliveOperations === 0 && !this.activePreviewRow()');
    expect(keepAlive).toContain('await this.setKeepAlive(false)');
  });
});
