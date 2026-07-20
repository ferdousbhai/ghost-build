import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runVerifierIfMain } from './run-verifier.mjs';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const builtWorkerConfigPath = resolve(rootDir, 'dist/server/wrangler.json');
const sourceLicenseArtifactPath = resolve(rootDir, 'public/THIRD_PARTY_LICENSES.txt');

function walkFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walkFiles(path) : [path];
  });
}

export function findStaticAssetExposureErrors({ assetDirectory, workerConfig, ignoreContent }) {
  const errors = [];
  if (workerConfig?.upload_source_maps !== true) {
    errors.push('The built Worker config must keep upload_source_maps enabled for private Worker diagnostics.');
  }

  const ignorePatterns = ignoreContent
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  if (!ignorePatterns.includes('*.map')) {
    errors.push('The deployed client asset root .assetsignore must contain *.map.');
  }
  if (ignorePatterns.some((pattern) => pattern.startsWith('!'))) {
    errors.push('The deployed client asset root .assetsignore must not re-include ignored files.');
  }

  const sourceMaps = walkFiles(assetDirectory)
    .filter((path) => path.endsWith('.map'))
    .map((path) => relative(assetDirectory, path))
    .sort();
  if (sourceMaps.length > 0 && !ignorePatterns.includes('*.map')) {
    errors.push(`Client source maps would be deployable: ${sourceMaps.join(', ')}.`);
  }
  return errors;
}

export function findDeployedLicenseArtifactErrors({ sourceContent, deployedContent }) {
  if (typeof sourceContent !== 'string' || sourceContent.length === 0) {
    return ['public/THIRD_PARTY_LICENSES.txt must be a non-empty generated license artifact.'];
  }
  if (deployedContent === null) {
    return ['The built client must include THIRD_PARTY_LICENSES.txt.'];
  }
  return deployedContent === sourceContent
    ? []
    : ['The built client THIRD_PARTY_LICENSES.txt must exactly match the generated public artifact.'];
}

export function verifyStaticAssets() {
  if (!existsSync(builtWorkerConfigPath)) {
    return ['dist/server/wrangler.json is missing; run pnpm run build before static asset verification.'];
  }
  const workerConfig = JSON.parse(readFileSync(builtWorkerConfigPath, 'utf8'));
  const configuredDirectory = workerConfig?.assets?.directory;
  if (typeof configuredDirectory !== 'string' || configuredDirectory.length === 0) {
    return ['The built Worker config must identify its static asset directory.'];
  }
  const assetDirectory = resolve(dirname(builtWorkerConfigPath), configuredDirectory);
  if (!existsSync(assetDirectory)) {
    return [`The built static asset directory does not exist: ${relative(rootDir, assetDirectory)}.`];
  }
  const ignorePath = resolve(assetDirectory, '.assetsignore');
  if (!existsSync(ignorePath)) {
    return [`${relative(rootDir, ignorePath)} is missing, so client source maps would be public.`];
  }
  const errors = findStaticAssetExposureErrors({
    assetDirectory,
    workerConfig,
    ignoreContent: readFileSync(ignorePath, 'utf8'),
  });
  const deployedLicenseArtifactPath = resolve(assetDirectory, 'THIRD_PARTY_LICENSES.txt');
  errors.push(
    ...findDeployedLicenseArtifactErrors({
      sourceContent: existsSync(sourceLicenseArtifactPath) ? readFileSync(sourceLicenseArtifactPath, 'utf8') : '',
      deployedContent: existsSync(deployedLicenseArtifactPath)
        ? readFileSync(deployedLicenseArtifactPath, 'utf8')
        : null,
    }),
  );
  return errors;
}

runVerifierIfMain(import.meta.url, verifyStaticAssets);
