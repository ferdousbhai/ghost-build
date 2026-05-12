import { Bot, CheckCircle2, Loader2, Square } from 'lucide-react'
import type { AgentPlanRequest } from '#/lib/agent'
import { buildEvents } from './builderConstants'
import type { BuilderMessage } from './builderTypes'

type MessageListProps = {
  isPending: boolean
  messages: Array<BuilderMessage>
  planReady: boolean
  goal: AgentPlanRequest['goal']
  onGoalObjectiveChange: (objective: string) => void
  onGoalSuccessCriteriaChange: (criteria: string) => void
}

export function MessageList({
  goal,
  isPending,
  messages,
  onGoalObjectiveChange,
  onGoalSuccessCriteriaChange,
  planReady,
}: MessageListProps) {
  return (
    <div className="messages">
      {messages.map((message) => (
        <article className={`message ${message.role}`} key={message.title}>
          <div className="avatar">
            {message.role === 'user'
              ? 'You'
              : message.role === 'system'
                ? 'Goal'
                : <Bot size={18} />}
          </div>
          <div>
            <span>{message.title}</span>
            <p>{message.body}</p>
          </div>
        </article>
      ))}

      <div className="agent-events">
        <div className="goal-summary">
          <span>Goal</span>
          <textarea
            value={goal?.objective || ''}
            placeholder="Working from the latest prompt"
            onChange={(event) => onGoalObjectiveChange(event.target.value)}
          />
          <textarea
            value={(goal?.successCriteria ?? []).join('\n')}
            placeholder="Add success criteria, one per line"
            onChange={(event) =>
              onGoalSuccessCriteriaChange(event.target.value)
            }
          />
        </div>

        {buildEvents.map((event, index) => {
          const isDone = planReady || index < 2
          const isActive = isPending && index === 2

          return (
            <div className="event-row" key={event}>
              <BuildEventIcon isActive={isActive} isDone={isDone} />
              <span>{event}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function BuildEventIcon({
  isActive,
  isDone,
}: {
  isActive: boolean
  isDone: boolean
}) {
  if (isActive) {
    return <Loader2 className="animate-spin" size={16} />
  }

  if (isDone) {
    return <CheckCircle2 size={16} />
  }

  return <Square size={14} />
}
