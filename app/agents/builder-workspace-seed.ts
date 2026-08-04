import type { BuilderWorkspaceApi } from './builder-workspace-api';
import type { BuilderWorkspaceFileInput, BuilderWorkspaceState } from './builder-workspace-types';
import { batchBuilderWorkspaceSeed, builderTemplateTotals } from './builder-template';

/**
 * Seed a workspace from the beginning. Replaying every batch is intentional:
 * Computer writes are replacements, so the same durable seed can resume after
 * an Agent eviction without maintaining a second progress ledger.
 */
export async function seedBuilderWorkspace(
  workspace: BuilderWorkspaceApi,
  seedId: string,
  entries: BuilderWorkspaceFileInput[],
): Promise<BuilderWorkspaceState> {
  const started = await workspace.beginSeed(seedId);
  if (started.status === 'initialized') {
    return started.state;
  }
  try {
    for (const batch of batchBuilderWorkspaceSeed(entries)) {
      await workspace.appendSeed(seedId, batch);
    }
    return await workspace.commitSeed(seedId, builderTemplateTotals(entries));
  } catch (error) {
    await workspace.abortSeed(seedId).catch(() => undefined);
    throw error;
  }
}
