import { Bot, CheckCircle2, Loader2, Square } from 'lucide-react'
import { buildEvents } from './builderConstants'
import type { BuilderMessage } from './builderTypes'

type MessageListProps = {
  isPending: boolean
  messages: Array<BuilderMessage>
  planReady: boolean
}

export function MessageList({ isPending, messages, planReady }: MessageListProps) {
  return (
    <div className="messages">
      {messages.map((message) => (
        <article className={`message ${message.role}`} key={message.title}>
          <div className="avatar">
            {message.role === 'user' ? 'You' : <Bot size={18} />}
          </div>
          <div>
            <span>{message.title}</span>
            <p>{message.body}</p>
          </div>
        </article>
      ))}

      <div className="agent-events">
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
