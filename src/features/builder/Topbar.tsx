import { Bot, Cloud, Wand2 } from 'lucide-react'
import { AuthButton } from '#/features/auth/AuthButton'
import { LocalOpenAIKeyButton } from '#/features/auth/LocalOpenAIKeyButton'

export function Topbar() {
  return (
    <header className="topbar">
      <a className="brand" href="/">
        <span className="brand-mark">
          <Wand2 size={18} />
        </span>
        <span>Ghost Coder</span>
      </a>

      <div className="topbar-actions">
        <span className="runtime-pill">
          <Bot size={15} />
          GPT-5.5 low
        </span>
        <span className="runtime-pill muted">
          <Cloud size={15} />
          Cloudflare Worker
        </span>
        <LocalOpenAIKeyButton />
        <AuthButton />
      </div>
    </header>
  )
}
