import { CheckCircle2, Globe2, Rocket } from 'lucide-react'
import type { AgentPlan } from '#/lib/agent'
import {
  defaultCapabilities,
  ownershipLineItems,
  productionSteps,
} from './builderConstants'

type PreviewPaneProps = {
  plan?: AgentPlan
}

export function PreviewPane({ plan }: PreviewPaneProps) {
  return (
    <aside className="workbench" aria-label="Build preview">
      <div className="workbench-header">
        <div>
          <span>Preview</span>
          <strong>{plan?.deployment.workerName ?? 'New Worker app'}</strong>
        </div>
        <button type="button">
          <Globe2 size={16} />
          Deploy
        </button>
      </div>

      <div className="preview-frame">
        <div className="preview-toolbar">
          <span />
          <span />
          <span />
          <p>{plan?.deployment.domain ?? 'preview.ghost-coder.local'}</p>
        </div>
        <div className="preview-content">
          <div className="preview-hero">
            <Rocket size={28} />
            <h2>{plan?.deployment.workerName ?? 'Your app preview'}</h2>
            <p>
              {plan
                ? 'The generated product preview will stream here while Think builds, checks, and deploys the Worker.'
                : 'After you send a prompt, the live app preview appears here. No code view required.'}
            </p>
          </div>
          <div className="preview-list">
            {(plan?.phases ?? []).map((phase) => (
              <div key={phase.title}>
                <CheckCircle2 size={16} />
                <span>{phase.title}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="deploy-card">
        <span>Default capabilities</span>
        <ChecklistItems items={defaultCapabilities} />
      </div>

      <div className="deploy-card">
        <span>Zero-to-production run</span>
        <ChecklistItems items={productionSteps} />
      </div>

      <div className="deploy-card wallet-card">
        <span>Open-source ownership model</span>
        <strong>Your keys, your cloud</strong>
        <p>
          Ghost Coder is open source. Users bring their own OpenAI key for
          model calls, while Cloudflare and Stripe handle payment for accounts,
          domains, Workers, storage, and other paid infrastructure actions.
        </p>
        {ownershipLineItems.map(([label, detail]) => (
          <div className="capability-row" key={label}>
            <CheckCircle2 size={16} />
            <p>
              <b>{label}</b>
              {detail}
            </p>
          </div>
        ))}
      </div>
    </aside>
  )
}

function ChecklistItems({ items }: { items: ReadonlyArray<string> }) {
  return items.map((item) => (
    <div className="capability-row" key={item}>
      <CheckCircle2 size={16} />
      <p>{item}</p>
    </div>
  ))
}
