import { expect, test, type Page, type TestInfo } from '@playwright/test';

function collectBrowserDiagnostics(page: Page, testInfo: TestInfo, allowExpectedDocumentNotFound = false) {
  const diagnostics: string[] = [];
  let expectedDocumentNotFoundBudget = allowExpectedDocumentNotFound ? 1 : 0;
  page.on('console', (message) => {
    if (message.type() === 'error') {
      if (expectedDocumentNotFoundBudget > 0 && message.text().includes('status of 404 (Not Found)')) {
        expectedDocumentNotFoundBudget -= 1;
        return;
      }
      diagnostics.push(`console: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => diagnostics.push(`pageerror: ${error.message}`));
  page.on('requestfailed', (request) => diagnostics.push(`requestfailed: ${request.method()} ${request.url()}`));
  return async () => {
    if (diagnostics.length > 0) {
      await testInfo.attach('browser-diagnostics', {
        body: Buffer.from(diagnostics.join('\n')),
        contentType: 'text/plain',
      });
    }
    expect(diagnostics, 'built browser emitted console, page, or network failures').toEqual([]);
  };
}

test('hydrates the built landing page without replacing meaningful SSR content', async ({ page }, testInfo) => {
  const assertClean = collectBrowserDiagnostics(page, testInfo);
  await page.setViewportSize({ width: 320, height: 800 });

  await page.goto('/');

  await expect(page).toHaveTitle(/Ghostbuild/);
  await expect(page.getByRole('heading', { name: /If you can dream it/i })).toBeVisible();
  await expect(page.getByPlaceholder(/Describe the app, workflow, and data/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect Cloudflare' }).first()).toBeVisible();
  const legalNotice = page.getByTestId('cloudflare-connect-legal-notice');
  await expect(legalNotice).toBeVisible();
  await expect(legalNotice.getByRole('link', { name: 'Terms' })).toBeVisible();
  expect(await page.locator('header').evaluate((header) => header.scrollWidth <= header.clientWidth)).toBe(true);
  await assertClean();
});

test('renders signed-out private routes after browser hydration', async ({ page }, testInfo) => {
  const assertClean = collectBrowserDiagnostics(page, testInfo);

  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: /Connect Cloudflare to open settings/i })).toBeVisible();
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex,\s*nofollow/);

  await page.goto('/chat/browser-smoke-project');
  await expect(page.getByRole('heading', { name: /Connect Cloudflare to open this project/i })).toBeVisible();
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex,\s*nofollow/);
  await assertClean();
});

test('keeps the built 404 and mobile shell usable', async ({ page }, testInfo) => {
  const assertClean = collectBrowserDiagnostics(page, testInfo, true);

  const response = await page.goto('/does-not-exist');

  expect(response?.status()).toBe(404);
  await expect(page.getByRole('heading', { name: 'This page does not exist.' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(
    true,
  );
  await assertClean();
});

test('renders the public trust routes and persists the telemetry choice', async ({ page }, testInfo) => {
  const assertClean = collectBrowserDiagnostics(page, testInfo);
  const routes = [
    ['/terms', 'You approve the build. You control the cloud account.'],
    ['/support', 'Get help through the right channel.'],
    ['/abuse', 'Report harmful use through the right channel.'],
    ['/security', 'Keep vulnerability details private.'],
  ] as const;

  for (const [path, heading] of routes) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
    ).toBe(true);
  }

  const securityTxt = await page.request.get('/.well-known/security.txt');
  expect(securityTxt.status()).toBe(200);
  expect(securityTxt.headers()['content-type']).toBe('text/plain; charset=utf-8');
  expect(await securityTxt.text()).toContain(
    'Contact: https://github.com/ferdousbhai/ghost-build/security/advisories/new',
  );

  await page.goto('/privacy');
  await expect(page.getByRole('heading', { name: 'How Ghostbuild handles your data.' })).toBeVisible();
  await expect(page.getByText('Product telemetry is disabled on this browser.')).toBeVisible();

  await page.getByRole('button', { name: 'Allow telemetry' }).click();
  await expect(page.getByText('Product telemetry is enabled on this browser.')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Product telemetry is enabled on this browser.')).toBeVisible();

  await page.getByRole('button', { name: 'Disable telemetry' }).click();
  await expect(page.getByText('Product telemetry is disabled on this browser.')).toBeVisible();
  await assertClean();
});
