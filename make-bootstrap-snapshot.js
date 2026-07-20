import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile as execFileCallback } from 'node:child_process';
import { snapshot } from '@webcontainer/snapshot';
import { promisify } from 'node:util';
import * as lz4 from 'lz4-wasm-nodejs';
import { createHash } from 'node:crypto';
import { listTemplateSourceFiles, templateSourceDigest } from './scripts/template-source.mjs';

const execFile = promisify(execFileCallback);

async function main() {
  const inputDir = 'template';
  const absoluteInputDir = path.resolve(inputDir);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webcontainer-snapshot-'));
  console.log('Temp directory:', tempDir);
  try {
    console.log('Listing tracked and untracked unignored template files...');
    const files = listTemplateSourceFiles(process.cwd());
    console.log(`Copying ${files.length} files to temp directory...`);
    await copyFilesToTemp(files, absoluteInputDir, tempDir);
    console.log('Verifying the standalone pnpm lockfile...');
    await execFile('pnpm', ['install', '--lockfile-only', '--frozen-lockfile'], { cwd: tempDir });
    console.log('Creating snapshot...');
    const buffer = await snapshot(tempDir);
    const compressed = lz4.compress(buffer);
    const sha256 = createHash('sha256').update(compressed).digest('hex').slice(0, 8);
    const filename = `template-snapshot-${sha256}.bin`;
    console.log(`Writing snapshot (${compressed.length} bytes) to ${filename}...`);
    await fs.writeFile(`public/${filename}`, compressed);
    await fs.writeFile(
      'public/template-snapshot-manifest.json',
      `${JSON.stringify({ snapshot: filename, sourceSha256: templateSourceDigest(process.cwd(), files) }, null, 2)}\n`,
    );

    console.log('Updating TEMPLATE_URL in useContainerSetup.ts...');
    const setupFilePath = 'app/lib/stores/startup/useContainerSetup.ts';
    const setupFileContent = await fs.readFile(setupFilePath, 'utf8');
    const templateUrlPattern = /const TEMPLATE_URL = ['"]\/template-snapshot-[a-f0-9]+\.bin['"];/;
    if (!templateUrlPattern.test(setupFileContent)) {
      throw new Error(`${setupFilePath} does not contain a replaceable TEMPLATE_URL declaration.`);
    }
    const nextSetupFileContent = setupFileContent.replace(templateUrlPattern, `const TEMPLATE_URL = '/${filename}';`);
    await fs.writeFile(setupFilePath, nextSetupFileContent);
    await removeStaleSnapshots(filename);
    console.log('Done!');
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function removeStaleSnapshots(currentFilename) {
  const publicDir = 'public';
  const files = await fs.readdir(publicDir);
  await Promise.all(
    files
      .filter((file) => /^template-snapshot-[a-f0-9]+\.bin$/.test(file))
      .filter((file) => file !== currentFilename)
      .map((file) => fs.rm(path.join(publicDir, file))),
  );
}

async function copyFilesToTemp(files, sourceDir, targetDir) {
  for (const file of files) {
    const relativePath = path.relative(sourceDir, file);
    console.log('Copying', relativePath);
    const sourcePath = file;
    const targetPath = path.join(targetDir, relativePath);

    // Create parent directories if they don't exist
    await fs.mkdir(path.dirname(targetPath), { recursive: true });

    // Copy the file
    await fs.copyFile(sourcePath, targetPath);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
