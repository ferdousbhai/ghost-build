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

  await page.goto('/');

  await expect(page).toHaveTitle(/Ghostbuild/);
  await expect(page.getByRole('heading', { name: /If you can dream it/i })).toBeVisible();
  await expect(page.getByPlaceholder(/Describe the app, workflow, and data/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect Cloudflare' }).first()).toBeVisible();
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
