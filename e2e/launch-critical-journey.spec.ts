import { expect, test } from '@playwright/test';
import { isAbsolute, relative, resolve } from 'node:path';

const authStatePath = validatedAuthStatePath(process.env.E2E_AUTH_STORAGE_STATE);
test.use({
  ...(authStatePath ? { storageState: authStatePath } : {}),
  // Authenticated traces, video, and screenshots can contain live cookies,
  // prompts, generated code, preview URLs, and deployment identifiers.
  trace: 'off',
  video: 'off',
  screenshot: 'off',
});

test('authenticated build, edit, preview, approval, and production journey', async ({ page }) => {
  test.setTimeout(60 * 60_000);
  const environment = requireCriticalJourneyEnvironment();
  const prompt = process.env.E2E_BUILD_PROMPT ?? 'Build a one-page launch checklist with durable task status.';

  const versionResponse = await page.request.get('/api/version');
  expect(versionResponse.ok()).toBe(true);
  const version = (await versionResponse.json()) as { sha?: string };
  if (version.sha !== environment.candidateSha) {
    throw new Error('The authenticated journey origin does not serve the exact release candidate.');
  }

  const connectionResponse = await page.request.get('/api/cloudflare/connection');
  expect(connectionResponse.ok()).toBe(true);
  const connection = (await connectionResponse.json()) as { accountId?: string };
  if (connection.accountId !== environment.stagingAccountId) {
    throw new Error('The authenticated Cloudflare connection does not match the isolated staging account.');
  }
  const runtimeSessionResponse = await page.request.post('/api/cloudflare/runtime-session', {
    headers: { Origin: new URL(environment.baseUrl).origin },
  });
  if (!runtimeSessionResponse.ok()) {
    throw new Error('The isolated Cloudflare Computer runtime session preflight failed.');
  }

  await page.goto('/');
  await page.getByPlaceholder(/Describe the app, workflow, and data/i).fill(prompt);
  await page.getByRole('button', { name: 'Send' }).click();

  await expect(page).toHaveURL(/\/chat\//, { timeout: 30_000 });
  await expect(page.getByText('Project validation passed')).toBeVisible({ timeout: 10 * 60_000 });
  await expect(page.getByRole('complementary', { name: 'Project workbench' })).toBeVisible();

  await page.getByText('Code', { exact: true }).click();
  const editor = page.locator('.cm-content').first();
  await editor.click();
  await editor.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End');
  await editor.pressSequentially('\n// launch-critical browser edit');
  await page.getByRole('button', { name: 'Save' }).first().click();

  await page.getByText('Preview', { exact: true }).click();
  const buildPreview = page.getByRole('button', { name: /Build preview|Refresh|Rebuild/ });
  if (await buildPreview.isVisible()) {
    await buildPreview.click();
  }
  const previewFrame = page.locator('iframe[title^="Remote preview for durable revision"]');
  await expect(previewFrame).toBeVisible({ timeout: 10 * 60_000 });
  const previewRevision = Number(/revision (\d+)/.exec((await previewFrame.getAttribute('title')) ?? '')?.[1]);
  expect(previewRevision).toBeGreaterThan(0);

  const approval = page.getByRole('heading', { name: 'Approve production deployment' });
  await expect(approval).toBeVisible({ timeout: 10 * 60_000 });
  const approvalSection = approval.locator('..').locator('..');
  await approvalSection.getByRole('checkbox').nth(0).check();
  await approvalSection.getByRole('checkbox').nth(1).check();
  await approvalSection.getByRole('button', { name: 'Approve deployment' }).click();

  const productionLink = approvalSection.getByRole('link', { name: 'Open deployment' });
  await expect(productionLink).toBeVisible({ timeout: 30 * 60_000 });
  const productionUrl = await productionLink.getAttribute('href');
  if (!productionUrl?.startsWith('https://')) {
    throw new Error('The deployment did not return a valid HTTPS production URL.');
  }
  const productionResponse = await page.request.get(productionUrl);
  expect(productionResponse.ok()).toBe(true);
});

function requireCriticalJourneyEnvironment() {
  const missing = [
    ['E2E_BASE_URL', process.env.E2E_BASE_URL],
    ['E2E_AUTH_STORAGE_STATE', authStatePath],
    ['E2E_STAGING_ACCOUNT', process.env.E2E_STAGING_ACCOUNT],
    ['E2E_CANDIDATE_SHA', process.env.E2E_CANDIDATE_SHA],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(
      `The launch-critical staging journey requires isolated resources; missing ${missing.join(', ')}. ` +
        'Do not point this suite at a personal or production Cloudflare account.',
    );
  }
  const baseUrl = new URL(process.env.E2E_BASE_URL!);
  if (
    baseUrl.protocol !== 'https:' ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.hostname === 'ghostbuild.dev' ||
    baseUrl.hostname === 'www.ghostbuild.dev'
  ) {
    throw new Error('E2E_BASE_URL must be a dedicated HTTPS staging origin and must never be ghostbuild.dev.');
  }
  const stagingAccountId = process.env.E2E_STAGING_ACCOUNT!;
  if (!/^[a-f0-9]{32}$/i.test(stagingAccountId)) {
    throw new Error('E2E_STAGING_ACCOUNT must be the exact 32-character Cloudflare staging account ID.');
  }
  const candidateSha = process.env.E2E_CANDIDATE_SHA!;
  if (!/^[a-f0-9]{40}$/.test(candidateSha)) {
    throw new Error('E2E_CANDIDATE_SHA must be the exact lowercase 40-character release commit SHA.');
  }
  return { baseUrl: baseUrl.toString(), candidateSha, stagingAccountId };
}

function validatedAuthStatePath(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const repositoryRoot = resolve(process.cwd());
  const resolvedPath = resolve(value);
  const repositoryRelative = relative(repositoryRoot, resolvedPath);
  const isInsideRepository =
    repositoryRelative !== '' && !repositoryRelative.startsWith('..') && !isAbsolute(repositoryRelative);
  if (isInsideRepository) {
    const ignoredAuthDirectory = resolve(repositoryRoot, 'playwright/.auth');
    const authRelative = relative(ignoredAuthDirectory, resolvedPath);
    if (authRelative === '' || authRelative.startsWith('..') || isAbsolute(authRelative)) {
      throw new Error('An in-repository E2E_AUTH_STORAGE_STATE must be stored under ignored playwright/.auth/.');
    }
  }
  return resolvedPath;
}
