import { useStore } from '@nanostores/react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { CheckIcon, ChevronDownIcon } from '@radix-ui/react-icons';
import { useEffect, useState } from 'react';
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
  const [open, setOpen] = useState(false);

  useEffect(() => {
    loadBuilderModelPreference();
    window.addEventListener('storage', syncBuilderModelPreference);
    return () => window.removeEventListener('storage', syncBuilderModelPreference);
  }, []);

  useEffect(() => {
    if (disabled) {
      setOpen(false);
    }
  }, [disabled]);

  return (
    <DropdownMenu.Root open={open} onOpenChange={setOpen}>
      <DropdownMenu.Trigger asChild disabled={disabled}>
        <button
          type="button"
          aria-label={`Builder model. Current: ${model.label}${disabled ? '. Stop or wait for the current response to finish before switching models.' : ''}`}
          className={classNames(
            'group inline-flex min-h-8 min-w-0 items-center gap-1.5 rounded-full border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 py-1 pl-3 pr-2 text-xs font-medium text-content-secondary outline-none transition-[color,background-color,border-color,box-shadow] hover:border-border-selected hover:bg-bolt-elements-background-depth-3 hover:text-content-primary focus-visible:ring-2 focus-visible:ring-accent-500 disabled:cursor-not-allowed disabled:opacity-50',
            compact ? 'w-36' : 'w-44 sm:w-auto sm:max-w-56',
          )}
          title={
            disabled
              ? 'Stop or wait for the current response to finish before switching models.'
              : `${model.label} — ${model.description} ${model.id}`
          }
        >
          <span className="truncate">{model.label}</span>
          {model.id === CLOUDFLARE_WORKERS_AI_MODEL && (
            <span className="shrink-0 text-content-tertiary">· default</span>
          )}
          <ChevronDownIcon
            className="ml-auto size-3.5 shrink-0 transition-transform duration-200 group-data-[state=open]:rotate-180"
            aria-hidden="true"
          />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="top"
          align="start"
          sideOffset={10}
          collisionPadding={12}
          aria-label="Builder model"
          className="z-50 max-h-[min(32rem,var(--radix-dropdown-menu-content-available-height))] w-[min(20rem,calc(100vw-1.5rem))] overflow-y-auto rounded-2xl border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 p-1.5 text-content-primary shadow-[0_24px_64px_rgba(0,0,0,0.42)] outline-none"
        >
          <DropdownMenu.RadioGroup
            value={modelId}
            onValueChange={(value) => {
              if (!disabled && isWorkersAiModelId(value)) {
                setBuilderModel(value);
              }
            }}
          >
            <ModelGroup label="Cloudflare hosted" availability="cloudflare-hosted" disabled={disabled} />
            <DropdownMenu.Separator className="mx-2 my-1.5 h-px bg-bolt-elements-borderColor" />
            <ModelGroup label="Partner via Cloudflare" availability="cloudflare-partner" disabled={disabled} />
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function ModelGroup({
  label,
  availability,
  disabled,
}: {
  label: string;
  availability: (typeof WORKERS_AI_MODELS)[number]['availability'];
  disabled: boolean;
}) {
  return (
    <DropdownMenu.Group>
      <DropdownMenu.Label className="px-3 pb-1.5 pt-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-content-tertiary">
        {label}
      </DropdownMenu.Label>
      {WORKERS_AI_MODELS.filter((model) => model.availability === availability).map((model) => (
        <DropdownMenu.RadioItem
          key={model.id}
          value={model.id}
          textValue={model.label}
          disabled={disabled}
          className="group/model relative flex min-h-14 cursor-pointer select-none items-center gap-3 rounded-xl px-3 py-2.5 outline-none transition-colors data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[highlighted]:bg-bolt-elements-background-depth-2 data-[state=checked]:bg-bolt-elements-item-backgroundAccent"
        >
          <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 group-data-[state=checked]/model:border-accent-500 group-data-[state=checked]/model:bg-accent-500 group-data-[state=checked]/model:text-white">
            <DropdownMenu.ItemIndicator>
              <CheckIcon className="size-3.5" />
            </DropdownMenu.ItemIndicator>
          </span>
          <span className="min-w-0 grow">
            <span className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold text-content-primary">{model.label}</span>
              {model.id === CLOUDFLARE_WORKERS_AI_MODEL && (
                <span className="shrink-0 rounded-full border border-accent-500/30 bg-accent-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-content-accent">
                  Default
                </span>
              )}
              {model.availability === 'cloudflare-partner' && (
                <span className="shrink-0 rounded-full border border-util-warning/30 bg-util-warning/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-content-warning">
                  Preview
                </span>
              )}
            </span>
            <span className="mt-0.5 block text-xs leading-4 text-content-secondary">{model.description}</span>
          </span>
        </DropdownMenu.RadioItem>
      ))}
    </DropdownMenu.Group>
  );
}
