import { describe, expect, test } from 'vitest';
import { DiagnosticsStore, parseOperationDiagnostics } from './diagnostics-store';
import { TOOL_PAGE_RECORDS } from './bounded-pagination';

describe('structured operation diagnostics', () => {
  test('parses and groups compiler diagnostics', () => {
    const records = parseOperationDiagnostics(
      ['src/app.ts(4,8): error TS2322: Wrong type', 'src/app.ts(4,8): error TS2322: Wrong type'].join('\n'),
      { operation: 'validation', check: 'typecheck' },
    );
    expect(records).toEqual([
      expect.objectContaining({
        path: 'src/app.ts',
        line: 4,
        column: 8,
        code: 'TS2322',
        message: 'Wrong type',
        occurrences: 2,
      }),
    ]);
  });

  test('continues immutable diagnostic records', () => {
    const store = new DiagnosticsStore();
    const records = Array.from({ length: TOOL_PAGE_RECORDS + 2 }, (_, index) => ({
      operation: 'validation' as const,
      severity: 'error' as const,
      message: `diagnostic ${index}`,
    }));
    const started = store.start('validation diagnostics', records);
    expect(started.diagnosticsId).toBeDefined();
    const second = store.read(started.diagnosticsId!, String(started.page.end));
    expect([...started.page.items, ...second.page.items]).toEqual(records);
    expect(second.page.complete).toBe(true);
  });

  test('drops operation diagnostics between user turns', () => {
    const store = new DiagnosticsStore();
    const records = Array.from({ length: TOOL_PAGE_RECORDS + 1 }, (_, index) => ({
      operation: 'validation' as const,
      severity: 'error' as const,
      message: `failure ${index}`,
    }));
    const { diagnosticsId } = store.start('validation diagnostics', records);

    store.clear();

    expect(() => store.read(diagnosticsId!)).toThrow('no longer available');
  });
});
