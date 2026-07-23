import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, printParseErrorCode } from 'jsonc-parser';
import { findWorkersBuildsConfigErrors, WORKERS_BUILDS_CONTAINER_SOURCE_FILES } from './workers-builds-config.mjs';
import { runVerifierIfMain } from './run-verifier.mjs';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function readJson(path, errors) {
  try {
    return JSON.parse(readFileSync(resolve(rootDir, path), 'utf8'));
  } catch (error) {
    errors.push(`${path} must be valid JSON: ${error instanceof Error ? error.message : String(error)}.`);
    return undefined;
  }
}

function readJsonc(path, errors) {
  const parseErrors = [];
  const config = parse(readFileSync(resolve(rootDir, path), 'utf8'), parseErrors, { allowTrailingComma: true });
  for (const error of parseErrors) {
    errors.push(`${path} has invalid JSONC: ${printParseErrorCode(error.error)} at offset ${error.offset}.`);
  }
  return config;
}

export function hashContainerSources(paths) {
  const hash = createHash('sha256');
  for (const path of paths) {
    hash.update(path);
    hash.update('\0');
    hash.update(readFileSync(resolve(rootDir, path)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function verifyWorkersBuildsConfig() {
  const errors = [];
  const config = readJson('workers-builds.production.json', errors);
  const packageJson = readJson('package.json', errors);
  const workerConfig = readJsonc('wrangler.jsonc', errors);
  const nvmrc = readFileSync(resolve(rootDir, '.nvmrc'), 'utf8');
  let containerSourceSha256;
  try {
    containerSourceSha256 = hashContainerSources(WORKERS_BUILDS_CONTAINER_SOURCE_FILES);
  } catch (error) {
    errors.push(
      `Workers Builds Container sources must be readable: ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  errors.push(
    ...findWorkersBuildsConfigErrors({
      config,
      packageJson,
      nvmrc,
      deployWorkflowExists: existsSync(resolve(rootDir, '.github/workflows/deploy.yml')),
      workerConfig,
      containerSourceSha256,
    }),
  );
  return errors;
}

runVerifierIfMain(import.meta.url, verifyWorkersBuildsConfig);
