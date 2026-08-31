import { atom } from 'nanostores';
import {
  CLOUDFLARE_WORKERS_AI_MODEL,
  DEFAULT_WORKERS_AI_MODEL,
  isWorkersAiModelId,
  validateWorkersAiModelCatalogPayload,
  workersAiModelCatalogPayloadSchema,
  type WorkersAiModel,
  type WorkersAiModelCatalogPayload,
  type WorkersAiModelId,
} from '~/lib/workers-ai-model';
import { fetchUserRuntime } from '~/lib/cloudflare/runtime-session';

const BUILDER_MODEL_STORAGE_KEY = 'ghostbuild_builder_model_v2';
let pendingCatalog: Promise<void> | null = null;

export const builderModelStore = atom<WorkersAiModelId>(CLOUDFLARE_WORKERS_AI_MODEL);
export const builderDefaultModelStore = atom<WorkersAiModelId>(CLOUDFLARE_WORKERS_AI_MODEL);
export const builderModelsStore = atom<readonly WorkersAiModel[]>([DEFAULT_WORKERS_AI_MODEL]);
export const builderModelCatalogStatusStore = atom<'idle' | 'loading' | 'ready' | 'error'>('idle');

export function initializeBuilderModelPreference(storage?: Pick<Storage, 'getItem'>): void {
  applyStoredModelPreference(storage);
}

export function loadBuilderModelPreference(storage?: Pick<Storage, 'getItem'>): void {
  applyStoredModelPreference(storage);
}

export function loadBuilderModelCatalog(
  request: typeof fetchUserRuntime = fetchUserRuntime,
  storage?: Pick<Storage, 'getItem'>,
): Promise<void> {
  if (pendingCatalog) {
    return pendingCatalog;
  }
  builderModelCatalogStatusStore.set('loading');
  const operation = request('/v1/models', { headers: { Accept: 'application/json' } })
    .then(async (response) => {
      const parsed = workersAiModelCatalogPayloadSchema.safeParse(await response.json().catch(() => null));
      const payload = parsed.success ? validateWorkersAiModelCatalogPayload(parsed.data) : null;
      if (!response.ok || payload === null) {
        throw new Error('The Workers AI model catalog response is invalid.');
      }
      installBuilderModelCatalog(payload, storage);
      builderModelCatalogStatusStore.set('ready');
    })
    .catch(() => {
      builderModelCatalogStatusStore.set('error');
    })
    .finally(() => {
      if (pendingCatalog === operation) {
        pendingCatalog = null;
      }
    });
  pendingCatalog = operation;
  return operation;
}

export function installBuilderModelCatalog(
  payload: WorkersAiModelCatalogPayload,
  storage?: Pick<Storage, 'getItem'>,
): void {
  builderModelsStore.set(payload.models);
  builderDefaultModelStore.set(payload.defaultModelId);
  applyStoredModelPreference(storage);
}

export function setBuilderModel(modelId: WorkersAiModelId, storage?: Pick<Storage, 'setItem'>): void {
  if (!builderModelsStore.get().some(({ id }) => id === modelId)) {
    return;
  }
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
  const models = builderModelsStore.get();
  builderModelStore.set(
    isWorkersAiModelId(event.newValue) && models.some(({ id }) => id === event.newValue)
      ? event.newValue
      : builderDefaultModelStore.get(),
  );
}

function applyStoredModelPreference(storage?: Pick<Storage, 'getItem'>): void {
  const defaultModel = builderDefaultModelStore.get();
  const models = builderModelsStore.get();
  try {
    const persisted = (storage ?? localStorage).getItem(BUILDER_MODEL_STORAGE_KEY);
    builderModelStore.set(
      isWorkersAiModelId(persisted) && models.some(({ id }) => id === persisted) ? persisted : defaultModel,
    );
  } catch {
    builderModelStore.set(defaultModel);
  }
}
