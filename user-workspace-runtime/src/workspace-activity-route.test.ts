import { describe, expect, it } from 'vitest';
import { readUserWorkspaceRuntimeActivity } from './workspace-activity-route';

const NOW = 10_000_000;

describe('user workspace runtime activity', () => {
  it('reports the lane a turn in progress is holding', async () => {
    const env = activityEnv({
      transcripts: ['agent-a'],
      lanes: { 'do:agent-a': { kind: 'exec', deadline: NOW + 60_000 } },
    });

    await expect(readUserWorkspaceRuntimeActivity(env, NOW)).resolves.toMatchObject({
      busy: true,
      observed: [{ kind: 'exec' }],
      candidates: 1,
    });
  });

  it('reports an idle workspace it was able to ask', async () => {
    const env = activityEnv({ transcripts: ['agent-a'], lanes: {} });

    await expect(readUserWorkspaceRuntimeActivity(env, NOW)).resolves.toMatchObject({ busy: false, candidates: 1 });
  });

  it('finds a deployment holding a lane on a chat whose transcript has gone quiet', async () => {
    const env = activityEnv({
      deployments: [`workspace-runtime:project-9:4:${'a'.repeat(64)}`],
      lanes: { 'project-9': { kind: 'deployment', deadline: NOW + 60_000 } },
    });

    await expect(readUserWorkspaceRuntimeActivity(env, NOW)).resolves.toMatchObject({
      busy: true,
      observed: [{ kind: 'deployment' }],
    });
  });

  it('only asks about work recent enough to still hold the longest lease', async () => {
    const env = activityEnv({ transcripts: ['agent-a'] });
    await readUserWorkspaceRuntimeActivity(env, NOW);

    expect(env.bindings[0]?.[0]).toBe(NOW - 60 * 60_000);
  });

  it('refuses to report idleness it could not observe', async () => {
    const env = activityEnv({
      transcripts: ['agent-a'],
      laneError: new Error('Durable Object reset because its code was updated.'),
    });

    await expect(readUserWorkspaceRuntimeActivity(env, NOW)).rejects.toThrow('reset because its code was updated');
  });
});

function activityEnv(options: {
  transcripts?: string[];
  deployments?: string[];
  lanes?: Record<string, { kind: string; deadline: number }>;
  laneError?: Error;
}) {
  const bindings: unknown[][] = [];
  return {
    bindings,
    DB: {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => {
          bindings.push(values);
          return {
            all: async () => ({
              results: sql.includes('chat_transcripts')
                ? (options.transcripts ?? []).map((agent_name) => ({ agent_name }))
                : (options.deployments ?? []).map((workspace_reference) => ({ workspace_reference })),
            }),
          };
        },
      }),
    },
    BuilderAgent: { idFromName: (name: string) => ({ toString: () => `do:${name}` }) },
    PROJECT_WORKSPACE: {
      idFromName: (name: string) => name,
      get: (id: string) => ({
        readOperationLaneState: async () => {
          if (options.laneError) {
            throw options.laneError;
          }
          return options.lanes?.[id] ?? null;
        },
      }),
    },
  } as unknown as Parameters<typeof readUserWorkspaceRuntimeActivity>[0] & { bindings: unknown[][] };
}
