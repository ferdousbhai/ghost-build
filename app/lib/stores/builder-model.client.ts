import { atom } from 'nanostores';
import type { AiGatewayCreditStatus } from '~/lib/cloudflare/ai-gateway-credit';
import {
  CLOUDFLARE_WORKERS_AI_MODEL,
  isWorkersAiModelId,
  PREFERRED_BUILDER_MODEL,
  type WorkersAiModelId,
} from '~/lib/workers-ai-model';

const BUILDER_MODEL_STORAGE_KEY = 'ghostbuild_builder_model';
let currentCreditStatus: AiGatewayCreditStatus = 'unknown';

export const builderModelStore = atom<WorkersAiModelId>(CLOUDFLARE_WORKERS_AI_MODEL);
export const builderDefaultModelStore = atom<WorkersAiModelId>(CLOUDFLARE_WORKERS_AI_MODEL);

export function initializeBuilderModelPreference(
  creditStatus: AiGatewayCreditStatus,
  storage?: Pick<Storage, 'getItem'>,
): void {
  currentCreditStatus = creditStatus;
  const defaultModel = creditStatus === 'available' ? PREFERRED_BUILDER_MODEL : CLOUDFLARE_WORKERS_AI_MODEL;
  builderDefaultModelStore.set(defaultModel);
  try {
    const persisted = (storage ?? localStorage).getItem(BUILDER_MODEL_STORAGE_KEY);
    builderModelStore.set(
      isWorkersAiModelId(persisted) && !(creditStatus !== 'available' && persisted === PREFERRED_BUILDER_MODEL)
        ? persisted
        : defaultModel,
    );
  } catch {
    builderModelStore.set(defaultModel);
  }
}

export function loadBuilderModelPreference(storage?: Pick<Storage, 'getItem'>): void {
  initializeBuilderModelPreference(currentCreditStatus, storage);
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
  builderModelStore.set(isWorkersAiModelId(event.newValue) ? event.newValue : builderDefaultModelStore.get());
}
