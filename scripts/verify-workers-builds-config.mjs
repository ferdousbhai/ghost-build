import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, printParseErrorCode } from 'jsonc-parser';
import { findWorkersBuildsConfigErrors } from './workers-builds-config.mjs';
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

export function verifyWorkersBuildsConfig() {
  const errors = [];
  const config = readJson('workers-builds.production.json', errors);
  const packageJson = readJson('package.json', errors);
  const workerConfig = readJsonc('wrangler.jsonc', errors);
  const nvmrc = readFileSync(resolve(rootDir, '.nvmrc'), 'utf8');
  const workflowsDirectory = resolve(rootDir, '.github/workflows');
  const githubWorkflowPaths = existsSync(workflowsDirectory)
    ? readdirSync(workflowsDirectory)
        .filter((entry) => /\.ya?ml$/i.test(entry))
        .sort()
        .map((entry) => `.github/workflows/${entry}`)
    : [];
  const browserGateWorkflowPath = resolve(rootDir, '.github/workflows/browser-gate.yml');
  errors.push(
    ...findWorkersBuildsConfigErrors({
      config,
      packageJson,
      nvmrc,
      githubWorkflowPaths,
      browserGateWorkflow: existsSync(browserGateWorkflowPath)
        ? readFileSync(browserGateWorkflowPath, 'utf8')
        : undefined,
      githubCompositeActionExists: existsSync(resolve(rootDir, '.github/actions/setup-and-build/action.yaml')),
      workerConfig,
    }),
  );
  return errors;
}

runVerifierIfMain(import.meta.url, verifyWorkersBuildsConfig);
