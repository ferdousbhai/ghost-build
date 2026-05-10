import { useEffect, useState } from 'react'
import { KeyRound, X } from 'lucide-react'
import { readLocalOpenAIKey, writeLocalOpenAIKey } from './localOpenAIKey'

export function LocalOpenAIKeyButton() {
  const [apiKey, setApiKey] = useState('')
  const [isEditing, setIsEditing] = useState(false)

  useEffect(() => {
    setApiKey(readLocalOpenAIKey())
  }, [])

  function saveKey(nextKey: string) {
    setApiKey(nextKey)
    writeLocalOpenAIKey(nextKey)
  }

  if (isEditing) {
    return (
      <div className="local-key-editor">
        <input
          autoFocus
          type="password"
          value={apiKey}
          placeholder="OpenAI API key"
          onChange={(event) => saveKey(event.target.value)}
        />
        <button
          aria-label="Close OpenAI key editor"
          type="button"
          onClick={() => setIsEditing(false)}
        >
          <X size={14} />
        </button>
      </div>
    )
  }

  return (
    <button
      className={`auth-pill ${apiKey ? '' : 'muted'}`}
      type="button"
      onClick={() => setIsEditing(true)}
    >
      <KeyRound size={15} />
      {apiKey ? 'OpenAI key saved locally' : 'Add OpenAI key'}
    </button>
  )
}
