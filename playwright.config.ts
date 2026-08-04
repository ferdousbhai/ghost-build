import { defineConfig, devices } from '@playwright/test';

const externalBaseUrl = process.env.E2E_BASE_URL;
const localBaseUrl = 'http://127.0.0.1:4173';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: process.env.CI ? 1 : undefined,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  outputDir: 'test-results/playwright',
  reporter: process.env.CI ? [['line'], ['html', { outputFolder: 'playwright-report', open: 'never' }]] : 'line',
  use: {
    baseURL: localBaseUrl,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm exec vite preview --host 127.0.0.1 --port 4173',
    url: `${localBaseUrl}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: /launch-critical-journey\.spec\.ts/,
      retries: process.env.CI ? 2 : 0,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile-chromium',
      testIgnore: /launch-critical-journey\.spec\.ts/,
      retries: process.env.CI ? 2 : 0,
      use: { ...devices['Pixel 7'] },
    },
    {
      name: 'launch-critical-chromium',
      testMatch: /launch-critical-journey\.spec\.ts/,
      // This journey creates billable resources and intentionally has no automatic cleanup yet.
      retries: 0,
      use: { ...devices['Desktop Chrome'], baseURL: externalBaseUrl ?? localBaseUrl },
    },
  ],
});
