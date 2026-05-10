export const openAIKeyStorageKey = 'ghost-coder.openai-api-key'

export function readLocalOpenAIKey() {
  return window.localStorage.getItem(openAIKeyStorageKey) ?? ''
}

export function writeLocalOpenAIKey(apiKey: string) {
  const normalizedKey = apiKey.trim()

  if (normalizedKey) {
    window.localStorage.setItem(openAIKeyStorageKey, normalizedKey)
  } else {
    window.localStorage.removeItem(openAIKeyStorageKey)
  }
}
