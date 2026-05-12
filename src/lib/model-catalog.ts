export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh'
export type ModelName = 'gpt-5.5'

export type ModelCatalogEntry = {
  id: ModelName
  displayName: string
  defaultReasoningEffort: ReasoningEffort
  supportedReasoningEfforts: Array<ReasoningEffort>
  availabilityNotes: string
}

export const modelCatalog = [
  {
    id: 'gpt-5.5',
    displayName: 'GPT-5.5',
    defaultReasoningEffort: 'low',
    supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    availabilityNotes:
      'Default GhostBuild model. Requests use GhostBuild server-side OpenAI API billing.',
  },
] as const satisfies Array<ModelCatalogEntry>

export const defaultModel = modelCatalog[0]

export function getModelCatalogEntry(model: ModelName = defaultModel.id) {
  const entry = modelCatalog.find((candidate) => candidate.id === model)

  if (!entry) {
    throw new Error(`Unsupported model: ${model}`)
  }

  return entry
}

export function normalizeReasoningEffort(
  model: ModelName,
  reasoningEffort?: ReasoningEffort,
) {
  const entry = getModelCatalogEntry(model)
  const requested = reasoningEffort ?? entry.defaultReasoningEffort

  if (!entry.supportedReasoningEfforts.includes(requested)) {
    return entry.defaultReasoningEffort
  }

  return requested
}
