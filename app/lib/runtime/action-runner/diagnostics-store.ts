import { recordPage, type RecordPage } from './bounded-pagination';

export type OperationDiagnostic = {
  operation: 'validation' | 'dependency-install';
  check?: string;
  severity: 'error' | 'warning';
  message: string;
  path?: string;
  line?: number;
  column?: number;
  code?: string;
  occurrences?: number;
  segment?: { index: number; total: number };
};

type StoredDiagnostics = {
  label: string;
  records: OperationDiagnostic[];
};

type StartedDiagnostics = {
  diagnosticsId?: string;
  page: RecordPage<OperationDiagnostic>;
};

export class DiagnosticsStore {
  #operations = new Map<string, StoredDiagnostics>();

  start(label: string, records: OperationDiagnostic[]): StartedDiagnostics {
    const page = recordPage(records, 0);
    if (page.complete) {
      return { page };
    }
    const diagnosticsId = crypto.randomUUID();
    this.#operations.set(diagnosticsId, { label, records: [...records] });
    return { diagnosticsId, page };
  }

  read(id: string, cursor?: string): { label: string; page: RecordPage<OperationDiagnostic> } {
    const stored = this.#operations.get(id);
    if (!stored) {
      throw new Error(`Diagnostics ${id} are no longer available. Run the originating operation again.`);
    }
    return { label: stored.label, page: recordPage(stored.records, numericCursor(cursor)) };
  }

  clear(): void {
    this.#operations.clear();
  }
}

export function parseOperationDiagnostics(
  text: string,
  context: { operation: OperationDiagnostic['operation']; check?: string },
): OperationDiagnostic[] {
  const lines = text
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  const grouped = new Map<string, { record: OperationDiagnostic; occurrences: number }>();
  for (const line of lines.length > 0 ? lines : ['Command failed without diagnostic output.']) {
    const record = parseDiagnosticLine(line, context);
    const key = JSON.stringify(record);
    const existing = grouped.get(key);
    if (existing) {
      existing.occurrences += 1;
    } else {
      grouped.set(key, { record, occurrences: 1 });
    }
  }
  return [...grouped.values()].flatMap(({ record, occurrences }) =>
    splitDiagnostic({ ...record, ...(occurrences > 1 ? { occurrences } : {}) }),
  );
}

function parseDiagnosticLine(
  line: string,
  context: { operation: OperationDiagnostic['operation']; check?: string },
): OperationDiagnostic {
  const typescript = line.match(/^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+([A-Z]+\d+):\s*(.*)$/i);
  if (typescript) {
    return diagnostic(context, typescript[4], typescript[6], {
      path: typescript[1],
      line: Number(typescript[2]),
      column: Number(typescript[3]),
      code: typescript[5],
    });
  }
  const eslint = line.match(/^(.+?):(\d+):(\d+)\s+(.+?)(?:\s+([@\w/-]+))?$/);
  if (eslint) {
    return diagnostic(context, 'error', eslint[4], {
      path: eslint[1],
      line: Number(eslint[2]),
      column: Number(eslint[3]),
      ...(eslint[5] ? { code: eslint[5] } : {}),
    });
  }
  const pnpm = line.match(/\b(ERR_PNPM_[A-Z0-9_]+)\b[:\s-]*(.*)$/);
  if (pnpm) {
    return diagnostic(context, 'error', pnpm[2] || line, { code: pnpm[1] });
  }
  return diagnostic(context, /warn/i.test(line) ? 'warning' : 'error', line);
}

function diagnostic(
  context: { operation: OperationDiagnostic['operation']; check?: string },
  severity: string,
  message: string,
  extra: Partial<OperationDiagnostic> = {},
): OperationDiagnostic {
  return {
    operation: context.operation,
    ...(context.check ? { check: context.check } : {}),
    severity: severity.toLowerCase() === 'warning' ? 'warning' : 'error',
    message,
    ...extra,
  };
}

function splitDiagnostic(record: OperationDiagnostic): OperationDiagnostic[] {
  const maximum = 3_000;
  if (record.message.length <= maximum) {
    return [record];
  }
  const total = Math.ceil(record.message.length / maximum);
  return Array.from({ length: total }, (_, index) => ({
    ...record,
    message: record.message.slice(index * maximum, (index + 1) * maximum),
    segment: { index: index + 1, total },
  }));
}

function numericCursor(cursor: string | undefined): number {
  if (!cursor) {
    return 0;
  }
  if (!/^\d+$/.test(cursor)) {
    throw new Error('Diagnostics cursor must be the exact non-negative integer returned by the previous page.');
  }
  return Number(cursor);
}
