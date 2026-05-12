import { Bot, Cloud, Wand2 } from 'lucide-react'

export function Topbar() {
  return (
    <header className="topbar">
      <a className="brand" href="/">
        <span className="brand-mark">
          <Wand2 size={18} />
        </span>
        <span>GhostBuild</span>
        <em>Goal-driven Cloudflare web app builder</em>
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
      </div>
    </header>
  )
}
