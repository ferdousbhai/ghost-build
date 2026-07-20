import { setTimeout as wait } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const VERSION_URL = 'https://ghostbuild.dev/api/version';
const GLOBALPING_API_URL = 'https://api.globalping.io/v1/measurements';
const GLOBALPING_LOCATIONS = [{ country: 'US' }, { country: 'DE' }, { country: 'JP' }];
const DEFAULT_STABILIZATION_MS = 60_000;
const DEFAULT_CHECK_INTERVAL_MS = 5_000;
const DEFAULT_CONSECUTIVE_CHECKS = 5;
const DEFAULT_MAX_LOCAL_ATTEMPTS = 15;

const waitFor = (delayMs) => wait(delayMs);

function headerValue(headers, name) {
  if (headers instanceof Headers) {
    return headers.get(name);
  }
  const entry = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  const value = entry?.[1];
  return Array.isArray(value) ? value.join(', ') : (value ?? null);
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function versionResponseErrors({ statusCode, headers, body, expectedSha }) {
  const errors = [];
  if (statusCode !== 200) {
    errors.push(`expected HTTP 200, received ${statusCode ?? 'no status'}`);
  }
  if (body?.sha !== expectedSha) {
    errors.push(`expected SHA ${expectedSha}, received ${body?.sha ?? '<empty>'}`);
  }
  if (typeof body?.versionId !== 'string' || body.versionId.length === 0) {
    errors.push('missing Worker version ID');
  }
  if (body?.oauthConfigured !== true) {
    errors.push('Cloudflare OAuth bindings are incomplete');
  }
  const cacheControl = headerValue(headers, 'cache-control') ?? '';
  if (
    !cacheControl
      .toLowerCase()
      .split(',')
      .some((directive) => directive.trim() === 'no-store')
  ) {
    errors.push(`expected Cache-Control: no-store, received ${cacheControl || '<empty>'}`);
  }
  return errors;
}

function probeSummary({ label, statusCode, headers, body, errors }) {
  const cfRay = headerValue(headers, 'cf-ray') ?? '<missing>';
  const sha = body?.sha ?? '<empty>';
  const versionId = body?.versionId ?? '<empty>';
  const oauthConfigured = body?.oauthConfigured === true ? 'ready' : 'incomplete';
  const outcome = errors.length === 0 ? 'ok' : errors.join('; ');
  return `${label}: ${outcome}; status=${statusCode ?? '<empty>'}; sha=${sha}; version=${versionId}; oauth=${oauthConfigured}; cf-ray=${cfRay}`;
}

async function fetchVersion(expectedSha, attempt, fetchImplementation) {
  const url = new URL(VERSION_URL);
  url.searchParams.set('deployment-check', `${expectedSha}-${attempt}-${Date.now()}`);
  const response = await fetchImplementation(url, {
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
    signal: AbortSignal.timeout(20_000),
  });
  const rawBody = await response.text();
  return {
    statusCode: response.status,
    headers: response.headers,
    body: parseJson(rawBody),
  };
}

/**
 * @param {{
 *   expectedSha?: string;
 *   fetchImplementation?: typeof fetch;
 *   stabilizationMs?: number;
 *   checkIntervalMs?: number;
 *   consecutiveChecks?: number;
 *   maxAttempts?: number;
 *   waitImplementation?: (delayMs: number) => Promise<unknown>;
 *   log?: (message: string) => void;
 * }} [options]
 */
export async function verifyLocalDeployment({
  expectedSha,
  fetchImplementation = fetch,
  stabilizationMs = DEFAULT_STABILIZATION_MS,
  checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS,
  consecutiveChecks = DEFAULT_CONSECUTIVE_CHECKS,
  maxAttempts = DEFAULT_MAX_LOCAL_ATTEMPTS,
  waitImplementation = waitFor,
  log = console.log,
} = {}) {
  if (!expectedSha) {
    throw new Error('EXPECTED_SHA is required.');
  }

  log(`Waiting ${stabilizationMs / 1000}s for Worker routing to stabilize.`);
  await waitImplementation(stabilizationMs);

  let consecutiveSuccesses = 0;
  let lastErrors = ['no probes completed'];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const probe = await fetchVersion(expectedSha, attempt, fetchImplementation);
      lastErrors = versionResponseErrors({ ...probe, expectedSha });
      log(probeSummary({ label: `Direct probe ${attempt}`, ...probe, errors: lastErrors }));
      consecutiveSuccesses = lastErrors.length === 0 ? consecutiveSuccesses + 1 : 0;
      if (consecutiveSuccesses >= consecutiveChecks) {
        return;
      }
    } catch (error) {
      consecutiveSuccesses = 0;
      lastErrors = [error instanceof Error ? error.message : String(error)];
      log(`Direct probe ${attempt}: ${lastErrors[0]}`);
    }
    if (attempt < maxAttempts) {
      await waitImplementation(checkIntervalMs);
    }
  }

  throw new Error(
    `Production did not return the expected version for ${consecutiveChecks} consecutive checks: ${lastErrors.join('; ')}`,
  );
}

function globalpingRequest(expectedSha) {
  return {
    target: 'ghostbuild.dev',
    type: 'http',
    locations: GLOBALPING_LOCATIONS,
    measurementOptions: {
      protocol: 'HTTPS',
      request: {
        method: 'GET',
        path: '/api/version',
        query: `deployment-check=${encodeURIComponent(expectedSha)}-${Date.now()}`,
        headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
      },
    },
  };
}

export function globalMeasurementErrors(measurement, expectedSha) {
  const errors = [];
  if (measurement?.status !== 'finished') {
    errors.push(`measurement status is ${measurement?.status ?? '<empty>'}`);
    return errors;
  }
  if (!Array.isArray(measurement.results) || measurement.results.length !== GLOBALPING_LOCATIONS.length) {
    errors.push(
      `expected ${GLOBALPING_LOCATIONS.length} regional results, received ${measurement?.results?.length ?? 0}`,
    );
  }
  for (const entry of measurement?.results ?? []) {
    const location = [entry.probe?.country, entry.probe?.city].filter(Boolean).join('/') || '<unknown>';
    const body = parseJson(entry.result?.rawBody ?? '');
    const probeErrors = versionResponseErrors({
      statusCode: entry.result?.statusCode,
      headers: entry.result?.headers,
      body,
      expectedSha,
    });
    console.log(
      probeSummary({
        label: `Regional probe ${location}`,
        statusCode: entry.result?.statusCode,
        headers: entry.result?.headers,
        body,
        errors: probeErrors,
      }),
    );
    errors.push(...probeErrors.map((error) => `${location}: ${error}`));
  }
  return errors;
}

async function fetchJson(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(20_000) });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`Globalping returned HTTP ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

/**
 * @param {{
 *   expectedSha?: string;
 *   waitImplementation?: (delayMs: number) => Promise<unknown>;
 * }} [options]
 */
export async function verifyGlobalDeployment({ expectedSha, waitImplementation = waitFor } = {}) {
  if (!expectedSha) {
    throw new Error('EXPECTED_SHA is required.');
  }

  const created = await fetchJson(GLOBALPING_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(globalpingRequest(expectedSha)),
  });
  if (!created?.id) {
    throw new Error('Globalping did not return a measurement ID.');
  }
  console.log(`Globalping measurement: https://globalping.io?measurement=${created.id}`);

  for (let attempt = 1; attempt <= 15; attempt += 1) {
    const measurement = await fetchJson(`${GLOBALPING_API_URL}/${created.id}`);
    if (measurement.status === 'finished') {
      const errors = globalMeasurementErrors(measurement, expectedSha);
      if (errors.length > 0) {
        throw new Error(`Multi-region verification failed: ${errors.join('; ')}`);
      }
      return;
    }
    await waitImplementation(2_000);
  }
  throw new Error('Globalping measurement did not finish within 30 seconds.');
}

async function main() {
  const expectedSha = process.env.EXPECTED_SHA;
  const mode = process.argv[2];
  if (mode === 'local') {
    await verifyLocalDeployment({ expectedSha });
    return;
  }
  if (mode === 'global') {
    await verifyGlobalDeployment({ expectedSha });
    return;
  }
  throw new Error('Usage: node scripts/verify-live-deployment.mjs <local|global>');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
