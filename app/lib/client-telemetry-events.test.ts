import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_CLIENT_TELEMETRY_EVENTS } from './client-telemetry-events';

const EMITTER_PATTERN = /capture(?:Message|Exception|ProductEvent)\(\s*'([^']+)'/g;
// The declaration module and the emitter itself name events without emitting them.
const NON_EMITTING_MODULES = new Set(['app/lib/client-telemetry-events.ts', 'app/lib/telemetry.client.ts']);

describe('declared client telemetry events', () => {
  it('has at least one production emitter for every declared event', () => {
    const emitted = emittedEventNames();
    const declaredWithoutEmitter = ALL_CLIENT_TELEMETRY_EVENTS.filter((event) => !emitted.has(event));

    expect(declaredWithoutEmitter).toEqual([]);
  });

  it('does not emit an event that is missing from the accepted enum', () => {
    const declared = new Set<string>(ALL_CLIENT_TELEMETRY_EVENTS);
    const emittedWithoutDeclaration = [...emittedEventNames()].filter((event) => !declared.has(event));

    expect(emittedWithoutDeclaration).toEqual([]);
  });
});

function emittedEventNames(): Set<string> {
  const emitted = new Set<string>();
  for (const path of productionSourceFiles('app')) {
    for (const [, event] of readFileSync(path, 'utf8').matchAll(EMITTER_PATTERN)) {
      emitted.add(event);
    }
  }
  return emitted;
}

function productionSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'generated' ? [] : productionSourceFiles(path);
    }
    if (!/\.tsx?$/.test(entry.name) || /\.(test|spec)\.tsx?$/.test(entry.name) || NON_EMITTING_MODULES.has(path)) {
      return [];
    }
    return [path];
  });
}
