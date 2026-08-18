import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BUILDER_SKILLS_POINTER_KEY } from '~/lib/.server/llm/builder-skills';
import { runUpstreamWatcher } from './upstream-sync';
import { BUILDER_SKILL_SOURCES } from './upstream-sources';

const revision = 'a'.repeat(40);

describe('upstream watcher reconciliation', () => {
  it('bootstraps an empty bucket and records the publication', async () => {
    const db = new FakeD1();
    const bucket = new FakeR2();
    const result = await runUpstreamWatcher(env(db, bucket), upstreamFixture(), 1_000);
    expect(result.status).toBe('published');
    expect(bucket.text(BUILDER_SKILLS_POINTER_KEY)).toContain(result.generation!);
    expect(db.state?.expected_generation).toBe(result.generation);
    expect(db.runs.get(result.runId)?.status).toBe('published');
  });

  it('verifies a healthy unchanged generation without republishing it', async () => {
    const db = new FakeD1();
    const bucket = new FakeR2();
    const request = upstreamFixture();
    const first = await runUpstreamWatcher(env(db, bucket), request, 1_000);
    const pointerWrites = bucket.pointerWrites;
    const second = await runUpstreamWatcher(env(db, bucket), request, 2_000);
    expect(first.status).toBe('published');
    expect(second.status).toBe('unchanged');
    expect(bucket.pointerWrites).toBe(pointerWrites);
    expect(db.runs.get(second.runId)?.status).toBe('unchanged');
  });

  it('repairs a stale pointer even when upstream revisions are unchanged', async () => {
    const db = new FakeD1();
    const bucket = new FakeR2();
    const request = upstreamFixture();
    const first = await runUpstreamWatcher(env(db, bucket), request, 1_000);
    bucket.forcePut(
      BUILDER_SKILLS_POINTER_KEY,
      JSON.stringify({
        version: 1,
        generation: 'f'.repeat(64),
        skills: ['cloudflare'],
      }),
    );
    const repaired = await runUpstreamWatcher(env(db, bucket), request, 2_000);
    expect(repaired.status).toBe('published');
    expect(repaired.generation).toBe(first.generation);
    expect(JSON.parse(bucket.text(BUILDER_SKILLS_POINTER_KEY)!)).toMatchObject({
      generation: first.generation,
    });
  });

  it('repairs missing generation files before checkpointing', async () => {
    const db = new FakeD1();
    const bucket = new FakeR2();
    const request = upstreamFixture();
    const first = await runUpstreamWatcher(env(db, bucket), request, 1_000);
    const generationPrefix = `generations/${first.generation}/skills/`;
    const missing = bucket.keys().find((key) => key.startsWith(generationPrefix))!;
    bucket.forceDelete(missing);
    const repaired = await runUpstreamWatcher(env(db, bucket), request, 2_000);
    expect(repaired.status).toBe('published');
    expect(bucket.keys()).toContain(missing);
  });

  it('fails closed when the pointer changes during publication', async () => {
    const db = new FakeD1();
    const bucket = new FakeR2();
    bucket.changePointerBeforeConditionalWrite = true;
    await expect(runUpstreamWatcher(env(db, bucket), upstreamFixture(), 1_000)).rejects.toThrow(
      'pointer changed during publication',
    );
    expect([...db.runs.values()].at(-1)?.status).toBe('error');
  });

  it('recovers when R2 publication succeeds but D1 finalization fails', async () => {
    const db = new FakeD1();
    const bucket = new FakeR2();
    const request = upstreamFixture();
    db.failNextSuccessfulFinalization = true;
    await expect(runUpstreamWatcher(env(db, bucket), request, 1_000)).rejects.toThrow(
      'simulated D1 finalization failure',
    );
    const liveGeneration = JSON.parse(bucket.text(BUILDER_SKILLS_POINTER_KEY)!).generation;
    const recovered = await runUpstreamWatcher(env(db, bucket), request, 2_000);
    expect(recovered.status).toBe('unchanged');
    expect(recovered.generation).toBe(liveGeneration);
    expect(db.state?.expected_generation).toBe(liveGeneration);
  });

  it('records preparation failures before a candidate exists', async () => {
    const db = new FakeD1();
    const bucket = new FakeR2();
    const request = (async () => new Response(null, { status: 503 })) as typeof fetch;
    await expect(runUpstreamWatcher(env(db, bucket), request, 1_000)).rejects.toThrow(
      'GitHub builder skill request failed',
    );
    expect([...db.runs.values()].at(-1)).toMatchObject({
      status: 'error',
      error: expect.stringContaining('GitHub builder skill request failed'),
    });
    expect(db.state?.active_run_id).toBeNull();
  });

  it('records a busy run without disturbing an active lock', async () => {
    const db = new FakeD1();
    const bucket = new FakeR2();
    await runUpstreamWatcher(env(db, bucket), upstreamFixture(), 1_000);
    db.state!.active_run_id = 'active';
    db.state!.active_run_started_at = 1_500;
    const result = await runUpstreamWatcher(env(db, bucket), upstreamFixture(), 2_000);
    expect(result.status).toBe('busy');
    expect(db.runs.get(result.runId)).toMatchObject({
      status: 'busy',
      error: 'Another builder skill sync is active.',
    });
    expect(db.state?.active_run_id).toBe('active');
  });

  it('marks an expired run failed before reclaiming its lock', async () => {
    const db = new FakeD1();
    const bucket = new FakeR2();
    await runUpstreamWatcher(env(db, bucket), upstreamFixture(), 1_000);
    db.state!.active_run_id = 'expired';
    db.state!.active_run_started_at = 1_000;
    db.runs.set('expired', {
      id: 'expired',
      status: 'running',
      started_at: 1_000,
    });
    const result = await runUpstreamWatcher(env(db, bucket), upstreamFixture(), 20 * 60 * 1_000 + 1_001);
    expect(result.status).toBe('unchanged');
    expect(db.runs.get('expired')).toMatchObject({
      status: 'error',
      error: 'Builder skill sync lease expired.',
    });
  });
});

function env(db: FakeD1, bucket: FakeR2): Env {
  return { DB: db, BUILDER_SKILLS: bucket } as unknown as Env;
}

function upstreamFixture(): typeof fetch {
  const files = new Map<string, Uint8Array>();
  const trees = new Map<string, ReturnType<typeof treeEntry>[]>();
  for (const source of BUILDER_SKILL_SOURCES) {
    const entries: ReturnType<typeof treeEntry>[] = [];
    for (const skillPath of source.skills) {
      const name = skillPath.split('/').at(-1)!;
      const bytes = new TextEncoder().encode(
        `---\nname: ${name}\ndescription: Official ${name} guidance.\n---\n\n# ${name}\n`,
      );
      files.set(`${source.repository}/${skillPath}/SKILL.md`, bytes);
      entries.push(treeEntry(`${skillPath}/SKILL.md`, bytes));
    }
    trees.set(source.repository, entries);
  }
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const source = BUILDER_SKILL_SOURCES.find(({ repository }) => url.includes(repository));
    if (!source) {
      return new Response(null, { status: 404 });
    }
    if (url.includes(`/commits/${source.defaultBranch}`)) {
      return Response.json({
        sha: revision,
        commit: { verification: { verified: true } },
      });
    }
    if (url.includes('/git/trees/')) {
      return Response.json({
        truncated: false,
        tree: trees.get(source.repository),
      });
    }
    const marker = `/${revision}/`;
    const path = decodeURIComponent(url.slice(url.indexOf(marker) + marker.length));
    const bytes = files.get(`${source.repository}/${path}`);
    return bytes ? new Response(Uint8Array.from(bytes)) : new Response(null, { status: 404 });
  }) as typeof fetch;
}

function treeEntry(path: string, bytes: Uint8Array) {
  return {
    path,
    sha: createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex'),
    type: 'blob',
    mode: '100644',
    size: bytes.byteLength,
  };
}

type State = {
  singleton: number;
  published_revisions_json: string;
  source_config_fingerprint: string;
  expected_generation: string | null;
  last_observed_revisions_json: string;
  last_checked_at: number;
  active_run_id: string | null;
  active_run_started_at: number | null;
};
type Run = Record<string, unknown> & {
  id: string;
  status: string;
  started_at: number;
};

class FakeD1 {
  state: State | null = null;
  runs = new Map<string, Run>();
  failNextSuccessfulFinalization = false;

  prepare(query: string) {
    const normalized = query.replaceAll(/\s+/g, ' ').trim();
    let values: unknown[] = [];
    const statement = {
      bind: (...bound: unknown[]) => {
        values = bound;
        return statement;
      },
      first: async <T>() => this.first(normalized, values) as T | null,
      run: async () => this.run(normalized, values),
    };
    return statement as unknown as D1PreparedStatement;
  }

  async batch(statements: D1PreparedStatement[]) {
    const snapshots = {
      state: this.state ? { ...this.state } : null,
      runs: new Map([...this.runs].map(([key, value]) => [key, { ...value }])),
    };
    try {
      const results = [];
      for (const statement of statements) {
        results.push(await statement.run());
      }
      return results;
    } catch (error) {
      this.state = snapshots.state;
      this.runs = snapshots.runs;
      throw error;
    }
  }

  private first(query: string, values: unknown[]): unknown {
    if (query.startsWith('SELECT active_run_id FROM builder_skill_sync_state WHERE singleton = 1 AND')) {
      if (
        this.state?.active_run_id &&
        (this.state.active_run_started_at === null || this.state.active_run_started_at <= Number(values[0]))
      ) {
        return { active_run_id: this.state.active_run_id };
      }
      return null;
    }
    if (query.startsWith('SELECT active_run_id FROM builder_skill_sync_state WHERE singleton = 1')) {
      return this.state ? { active_run_id: this.state.active_run_id } : null;
    }
    if (query.startsWith('SELECT published_revisions_json')) {
      return this.state;
    }
    throw new Error(`Unhandled fake D1 first: ${query}`);
  }

  private async run(query: string, values: unknown[]) {
    let changes = 0;
    if (query.startsWith('INSERT INTO builder_skill_sync_runs')) {
      const [id, startedAt] = values as [string, number];
      this.runs.set(id, { id, status: 'running', started_at: startedAt });
      changes = 1;
    } else if (query.startsWith('INSERT OR IGNORE INTO builder_skill_sync_state')) {
      if (!this.state) {
        const [published, fingerprint, observed, checkedAt] = values as [string, string, string, number];
        this.state = {
          singleton: 1,
          published_revisions_json: published,
          source_config_fingerprint: fingerprint,
          expected_generation: null,
          last_observed_revisions_json: observed,
          last_checked_at: checkedAt,
          active_run_id: null,
          active_run_started_at: null,
        };
        changes = 1;
      }
    } else if (query.includes('SET active_run_id = ?, active_run_started_at = ?')) {
      if (this.state && this.state.active_run_id === null) {
        this.state.active_run_id = values[0] as string;
        this.state.active_run_started_at = values[1] as number;
        changes = 1;
      }
    } else if (
      query.includes('SET active_run_id = NULL, active_run_started_at = NULL') &&
      query.includes('active_run_id = ?')
    ) {
      if (this.state !== null && this.state.active_run_id === values.at(-1)) {
        this.state.active_run_id = null;
        this.state.active_run_started_at = null;
        changes = 1;
      }
    } else if (query.includes('SET last_observed_revisions_json = ?, last_checked_at = ?')) {
      if (this.state !== null && this.state.active_run_id === values[2]) {
        this.state.last_observed_revisions_json = values[0] as string;
        this.state.last_checked_at = values[1] as number;
        changes = 1;
      }
    } else if (query.includes('SET published_revisions_json = ?, source_config_fingerprint = ?')) {
      if (this.failNextSuccessfulFinalization) {
        this.failNextSuccessfulFinalization = false;
        throw new Error('simulated D1 finalization failure');
      }
      if (this.state !== null && this.state.active_run_id === values[5]) {
        this.state.published_revisions_json = values[0] as string;
        this.state.source_config_fingerprint = values[1] as string;
        this.state.expected_generation = values[2] as string;
        this.state.last_observed_revisions_json = values[3] as string;
        this.state.last_checked_at = values[4] as number;
        this.state.active_run_id = null;
        this.state.active_run_started_at = null;
        changes = 1;
      }
    } else if (query.startsWith('UPDATE builder_skill_sync_runs')) {
      const runId = values.at(-1) as string;
      const run = this.runs.get(runId);
      if (run?.status === 'running') {
        if (query.includes('SET source_revisions_json = ?')) {
          run.source_revisions_json = values[0];
        } else if (query.includes("SET status = 'error', completed_at = ?, error = ?")) {
          Object.assign(run, {
            status: 'error',
            completed_at: values[0],
            error: values[1],
          });
        } else if (query.includes("SET status = 'error'")) {
          Object.assign(run, {
            status: 'error',
            completed_at: values[0],
            source_revisions_json: values[1] ?? run.source_revisions_json,
            previous_generation: values[2],
            generation: values[3],
            file_count: values[4],
            error: values[5],
          });
        } else if (query.includes('SET status = ?, completed_at = ?, source_revisions_json = ?')) {
          Object.assign(run, {
            status: values[0],
            completed_at: values[1],
            source_revisions_json: values[2],
            previous_generation: values[3],
            generation: values[4],
            file_count: values[5],
          });
        } else if (query.includes("SET status = 'busy', completed_at = ?, error = ?")) {
          Object.assign(run, {
            status: 'busy',
            completed_at: values[0],
            error: values[1],
          });
        } else {
          throw new Error(`Unhandled fake D1 run update: ${query}`);
        }
        changes = 1;
      }
    } else {
      throw new Error(`Unhandled fake D1 run: ${query}`);
    }
    return { success: true, meta: { changes } } as unknown as D1Result;
  }
}

class FakeR2 {
  private objects = new Map<string, { bytes: Uint8Array; etag: string; uploaded: Date; contentType?: string }>();
  pointerWrites = 0;
  changePointerBeforeConditionalWrite = false;

  async get(key: string) {
    const value = this.objects.get(key);
    return value ? this.object(key, value) : null;
  }

  async put(key: string, value: string | Uint8Array, options: R2PutOptions = {}) {
    if (key === BUILDER_SKILLS_POINTER_KEY && this.changePointerBeforeConditionalWrite) {
      this.changePointerBeforeConditionalWrite = false;
      this.forcePut(
        key,
        JSON.stringify({
          version: 1,
          generation: 'e'.repeat(64),
          skills: ['external'],
        }),
      );
    }
    const current = this.objects.get(key);
    const onlyIf = options.onlyIf as R2Conditional | undefined;
    if (
      (onlyIf?.etagMatches !== undefined && current?.etag !== onlyIf.etagMatches) ||
      (onlyIf?.etagDoesNotMatch === '*' && current !== undefined)
    ) {
      return null;
    }
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : Uint8Array.from(value);
    const stored = {
      bytes,
      etag: createHash('md5').update(bytes).digest('hex'),
      uploaded: new Date(),
      contentType:
        options.httpMetadata && 'contentType' in options.httpMetadata ? options.httpMetadata.contentType : undefined,
    };
    this.objects.set(key, stored);
    if (key === BUILDER_SKILLS_POINTER_KEY) {
      this.pointerWrites += 1;
    }
    return this.object(key, stored);
  }

  async delete(keys: string | string[]) {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      this.objects.delete(key);
    }
  }

  async list(options: R2ListOptions = {}) {
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(options.prefix ?? '')).toSorted();
    return {
      objects: keys.map((key) => this.object(key, this.objects.get(key)!)),
      truncated: false,
      delimitedPrefixes: [],
    } as unknown as R2Objects;
  }

  keys(): string[] {
    return [...this.objects.keys()];
  }

  forceDelete(key: string) {
    this.objects.delete(key);
  }

  forcePut(key: string, value: string) {
    const bytes = new TextEncoder().encode(value);
    this.objects.set(key, {
      bytes,
      etag: createHash('md5').update(bytes).digest('hex'),
      uploaded: new Date(),
    });
    if (key === BUILDER_SKILLS_POINTER_KEY) {
      this.pointerWrites += 1;
    }
  }

  text(key: string): string | null {
    const value = this.objects.get(key);
    return value ? new TextDecoder().decode(value.bytes) : null;
  }

  private object(
    key: string,
    value: {
      bytes: Uint8Array;
      etag: string;
      uploaded: Date;
      contentType?: string;
    },
  ) {
    return {
      key,
      size: value.bytes.byteLength,
      etag: value.etag,
      httpEtag: `"${value.etag}"`,
      uploaded: value.uploaded,
      storageClass: 'Standard',
      checksums: {
        sha256: createHash('sha256').update(value.bytes).digest().buffer,
      },
      httpMetadata: { contentType: value.contentType },
      customMetadata: {},
      range: undefined,
      body: new Blob([Uint8Array.from(value.bytes)]).stream(),
      bodyUsed: false,
      text: async () => new TextDecoder().decode(value.bytes),
      json: async () => JSON.parse(new TextDecoder().decode(value.bytes)),
      blob: async () => new Blob([Uint8Array.from(value.bytes)]),
      arrayBuffer: async () => Uint8Array.from(value.bytes).buffer,
      writeHttpMetadata: () => undefined,
    } as unknown as R2ObjectBody;
  }
}
