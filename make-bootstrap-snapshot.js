import { existsSync, promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { exec as execCallback } from 'child_process';
import { snapshot } from '@webcontainer/snapshot';
import { promisify } from 'util';
import * as lz4 from 'lz4-wasm-nodejs';
import { createHash } from 'crypto';

const exec = promisify(execCallback);

async function main() {
  const inputDir = 'template';
  const absoluteInputDir = path.resolve(inputDir);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'webcontainer-snapshot-'));
  console.log('Temp directory:', tempDir);

  console.log('Using git to list tracked and untracked unignored template files...');
  const files = await getSnapshotFiles(absoluteInputDir);
  console.log(`Copying ${files.length} files to temp directory...`);
  await copyFilesToTemp(files, absoluteInputDir, tempDir);
  console.log('Generating standalone pnpm lockfile...');
  await exec('pnpm install --lockfile-only', { cwd: tempDir });
  console.log('Creating snapshot...');
  const buffer = await snapshot(tempDir);
  const compressed = lz4.compress(buffer);
  const sha256 = createHash('sha256').update(compressed).digest('hex').slice(0, 8);
  const filename = `template-snapshot-${sha256}.bin`;
  console.log(`Writing snapshot (${compressed.length} bytes) to ${filename}...`);
  await fs.writeFile(`public/${filename}`, compressed);
  await removeStaleSnapshots(filename);

  // Update TEMPLATE_URL in useContainerSetup.ts
  console.log('Updating TEMPLATE_URL in useContainerSetup.ts...');
  const setupFilePath = 'app/lib/stores/startup/useContainerSetup.ts';
  let setupFileContent = await fs.readFile(setupFilePath, 'utf8');
  setupFileContent = setupFileContent.replace(
    /const TEMPLATE_URL = ['"]\/template-snapshot-[a-f0-9]+\.bin['"];/,
    `const TEMPLATE_URL = '/${filename}';`,
  );
  await fs.writeFile(setupFilePath, setupFileContent);

  console.log('Done!');
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

async function getSnapshotFiles(dir) {
  try {
    const { stdout } = await exec('git ls-files --cached --others --exclude-standard', {
      cwd: dir,
      encoding: 'utf8',
    });
    if (!stdout) {
      throw new Error('No output from git ls-files');
    }
    const unignoredFiles = stdout
      .trim()
      .split('\n')
      .filter((file) => file.length > 0)
      .filter((file) => existsSync(path.join(dir, file)));
    return unignoredFiles;
  } catch (error) {
    console.error('Error using git to list files', error);
    process.exit(1);
  }
}

async function copyFilesToTemp(files, sourceDir, targetDir) {
  for (const file of files) {
    console.log('Copying', file);
    const sourcePath = path.join(sourceDir, file);
    const targetPath = path.join(targetDir, file);

    // Create parent directories if they don't exist
    await fs.mkdir(path.dirname(targetPath), { recursive: true });

    // Copy the file
    await fs.copyFile(sourcePath, targetPath);
  }
}

main();
