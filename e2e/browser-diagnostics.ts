import { expect, type Page, type TestInfo } from '@playwright/test';

/**
 * Fails the calling test when the browser reports a console error, an uncaught
 * page error, or a failed request. Never use this for the authenticated
 * journey: request URLs and console text there can carry live credentials.
 */
export function collectBrowserDiagnostics(page: Page, testInfo: TestInfo, expectedDiagnostics: RegExp[] = []) {
  const diagnostics: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
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
    const unexpected = diagnostics.filter(
      (diagnostic) => !expectedDiagnostics.some((expected) => expected.test(diagnostic)),
    );
    expect(unexpected, 'the browser emitted unexpected console, page, or network failures').toEqual([]);
  };
}
