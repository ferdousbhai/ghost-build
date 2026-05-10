import { MessageSquarePlus, Sparkles } from 'lucide-react'
import { promptSuggestions } from './builderConstants'

type IntroPanelProps = {
  onSelectSuggestion: (suggestion: string) => void
}

export function IntroPanel({ onSelectSuggestion }: IntroPanelProps) {
  return (
    <div className="intro-panel">
      <div className="intro-icon">
        <Sparkles size={24} />
      </div>
      <h1>What app should Ghost Coder build?</h1>
      <p>
        Describe the product in plain English. The agent uses Think, the
        Cloudflare API MCP server, and Cloudflare Skills to build and deploy it
        as a production Worker.
      </p>

      <div className="suggestions">
        {promptSuggestions.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => onSelectSuggestion(suggestion)}
          >
            <MessageSquarePlus size={16} />
            {suggestion}
          </button>
        ))}
      </div>
    </div>
  )
}
