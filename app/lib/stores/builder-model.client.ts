import { atom } from 'nanostores';
import { CLOUDFLARE_WORKERS_AI_MODEL, isWorkersAiModelId, type WorkersAiModelId } from '~/lib/workers-ai-model';

const BUILDER_MODEL_STORAGE_KEY = 'ghostbuild_builder_model';

export const builderModelStore = atom<WorkersAiModelId>(CLOUDFLARE_WORKERS_AI_MODEL);

export function loadBuilderModelPreference(storage?: Pick<Storage, 'getItem'>): void {
  try {
    const persisted = (storage ?? localStorage).getItem(BUILDER_MODEL_STORAGE_KEY);
    builderModelStore.set(isWorkersAiModelId(persisted) ? persisted : CLOUDFLARE_WORKERS_AI_MODEL);
  } catch {
    builderModelStore.set(CLOUDFLARE_WORKERS_AI_MODEL);
  }
}

export function setBuilderModel(modelId: WorkersAiModelId, storage?: Pick<Storage, 'setItem'>): void {
  builderModelStore.set(modelId);
  try {
    (storage ?? localStorage).setItem(BUILDER_MODEL_STORAGE_KEY, modelId);
  } catch {
    // The in-memory preference still applies when browser storage is unavailable.
  }
}

export function syncBuilderModelPreference(event: Pick<StorageEvent, 'key' | 'newValue'>): void {
  if (event.key !== BUILDER_MODEL_STORAGE_KEY) {
    return;
  }
  builderModelStore.set(isWorkersAiModelId(event.newValue) ? event.newValue : CLOUDFLARE_WORKERS_AI_MODEL);
}
