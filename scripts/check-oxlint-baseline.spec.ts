import { describe, expect, it } from 'vitest';

import { compareToBaseline, tallyDiagnostics, total } from './check-oxlint-baseline.mjs';

const diagnostic = (filename: string, code: string) => ({ filename, code, severity: 'error', message: '' });

describe('anti-slop tally', () => {
  it('counts findings per file and rule for both plugin groups', () => {
    expect(
      tallyDiagnostics([
        diagnostic('a.ts', 'anti-slop(no-runtime-typeof)'),
        diagnostic('a.ts', 'anti-slop(no-runtime-typeof)'),
        diagnostic('a.ts', 'anti-slop(no-unknown-parameters)'),
        diagnostic('b.ts', 'unicorn(no-useless-spread)'),
      ]),
    ).toEqual({
      'a.ts': { 'anti-slop/no-runtime-typeof': 2, 'anti-slop/no-unknown-parameters': 1 },
      'b.ts': { 'unicorn/no-useless-spread': 1 },
    });
  });

  it('counts core Oxlint rules too, not just the vendored plugin', () => {
    // Scoping the baseline to anti-slop left every core rule gated by nothing: lint filtered them
    // out and exited 0 while real findings sat in the tree. A baseline that silently ignores a
    // whole class of rule is worse than none, because it looks like one.
    expect(tallyDiagnostics([diagnostic('a.ts', 'eslint(no-unused-vars)')])).toEqual({
      'a.ts': { 'eslint/no-unused-vars': 1 },
    });
  });
});

describe('baseline comparison', () => {
  const baseline = { 'a.ts': { 'anti-slop/no-runtime-typeof': 2 }, 'b.ts': { 'anti-slop/no-unknown-returns': 1 } };

  it('passes an unchanged tree', () => {
    expect(compareToBaseline(baseline, baseline)).toEqual({ regressions: [], improvements: [] });
  });

  it('reports a rule that grew in a file that already had debt', () => {
    const { regressions } = compareToBaseline({ ...baseline, 'a.ts': { 'anti-slop/no-runtime-typeof': 3 } }, baseline);
    expect(regressions).toEqual([{ file: 'a.ts', rule: 'anti-slop/no-runtime-typeof', baseline: 2, current: 3 }]);
  });

  it('reports a rule that is new to a file that already had other debt', () => {
    // Per file *and* per rule: a file carrying one kind of debt must not become a free pass for
    // every other rule in it.
    const { regressions } = compareToBaseline(
      { ...baseline, 'a.ts': { 'anti-slop/no-runtime-typeof': 2, 'anti-slop/no-unknown-parameters': 1 } },
      baseline,
    );
    expect(regressions).toEqual([{ file: 'a.ts', rule: 'anti-slop/no-unknown-parameters', baseline: 0, current: 1 }]);
  });

  it('reports an entirely new file', () => {
    const { regressions } = compareToBaseline({ ...baseline, 'c.ts': { 'anti-slop/no-reflect-get': 1 } }, baseline);
    expect(regressions).toEqual([{ file: 'c.ts', rule: 'anti-slop/no-reflect-get', baseline: 0, current: 1 }]);
  });

  it('treats a fixed finding as slack to reclaim, not as budget to spend elsewhere', () => {
    const { regressions, improvements } = compareToBaseline({ 'a.ts': { 'anti-slop/no-runtime-typeof': 1 } }, baseline);
    expect(regressions).toEqual([]);
    expect(improvements).toEqual([
      { file: 'a.ts', rule: 'anti-slop/no-runtime-typeof', baseline: 2, current: 1 },
      { file: 'b.ts', rule: 'anti-slop/no-unknown-returns', baseline: 1, current: 0 },
    ]);
  });
});

describe('recorded baseline', () => {
  it('matches the total it records', async () => {
    const recorded = (await import('./oxlint-baseline.json', { with: { type: 'json' } })).default;
    expect(total(recorded.counts)).toBe(recorded.total);
  });
});
