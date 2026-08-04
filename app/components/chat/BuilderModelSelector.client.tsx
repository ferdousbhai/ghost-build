import { useStore } from '@nanostores/react';
import { ChevronDownIcon } from '@radix-ui/react-icons';
import { useEffect } from 'react';
import {
  CLOUDFLARE_WORKERS_AI_MODEL,
  getWorkersAiModel,
  isWorkersAiModelId,
  WORKERS_AI_MODELS,
} from '~/lib/workers-ai-model';
import {
  builderModelStore,
  loadBuilderModelPreference,
  setBuilderModel,
  syncBuilderModelPreference,
} from '~/lib/stores/builder-model.client';
import { classNames } from '~/utils/classNames';

export function BuilderModelSelector({ compact = false, disabled = false }: { compact?: boolean; disabled?: boolean }) {
  const modelId = useStore(builderModelStore);
  const model = getWorkersAiModel(modelId);

  useEffect(() => {
    loadBuilderModelPreference();
    window.addEventListener('storage', syncBuilderModelPreference);
    return () => window.removeEventListener('storage', syncBuilderModelPreference);
  }, []);

  return (
    <label
      className={classNames(
        'relative inline-flex min-w-0 items-center rounded-full border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-content-secondary transition-colors focus-within:ring-2 focus-within:ring-accent-500',
        disabled ? 'opacity-50' : 'hover:bg-bolt-elements-background-depth-3',
      )}
      title={`${model.label} — ${model.description} ${model.id}`}
    >
      <span className="sr-only">Builder model</span>
      <select
        aria-label={`Builder model. Current: ${model.label}`}
        className={classNames(
          'min-h-8 cursor-pointer appearance-none truncate bg-transparent py-1 pl-2.5 pr-7 text-xs font-medium outline-none disabled:cursor-not-allowed',
          compact ? 'w-36' : 'w-44 sm:w-auto sm:max-w-56',
        )}
        disabled={disabled}
        value={modelId}
        onChange={(event) => {
          if (isWorkersAiModelId(event.currentTarget.value)) {
            setBuilderModel(event.currentTarget.value);
          }
        }}
      >
        <optgroup label="Cloudflare-hosted">
          {WORKERS_AI_MODELS.filter(({ availability }) => availability === 'cloudflare-hosted').map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
              {option.id === CLOUDFLARE_WORKERS_AI_MODEL ? ' · default' : ''}
            </option>
          ))}
        </optgroup>
        <optgroup label="Partner via Cloudflare">
          {WORKERS_AI_MODELS.filter(({ availability }) => availability === 'cloudflare-partner').map((option) => (
            <option key={option.id} value={option.id}>
              {option.label} · partner preview
            </option>
          ))}
        </optgroup>
      </select>
      <ChevronDownIcon className="pointer-events-none absolute right-2 size-3.5" aria-hidden="true" />
    </label>
  );
}
