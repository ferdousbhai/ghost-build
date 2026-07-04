import { createFileRoute } from "@tanstack/react-router";
import { Bot, Cloud, DatabaseZap, Loader2, Send, Trash2 } from "lucide-react";
import { useLiveQuery } from "@tanstack/react-db";
import { type ReactNode, useState } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import type { AppAgent, AppAgentState } from "../agents/app-agent";
import { addDecision, decisionsCollection } from "../db/app-db";
import { WORKERS_AI_CODING_MODEL } from "../workers-ai.shared";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  const [prompt, setPrompt] = useState(
    "Suggest a useful first feature for this app.",
  );
  const [agentNote, setAgentNote] = useState(
    "Track the first product decision.",
  );
  const [agentState, setAgentState] = useState<AppAgentState>({
    notes: [],
    lastSummary: null,
    updatedAt: null,
  });
  const { data: decisions = [], isLoading: decisionsLoading } =
    useLiveQuery(decisionsCollection);

  const appAgent = useAgent<AppAgent, AppAgentState>({
    agent: "AppAgent",
    name: "default",
    onStateUpdate: (state) => setAgentState(state),
  });
  const {
    messages: aiMessages,
    sendMessage,
    clearHistory,
    status: chatStatus,
    stop,
    isRecovering,
  } = useAgentChat({ agent: appAgent });
  const agentReady = !appAgent.connectionError && appAgent.state !== undefined;
  const isAsking =
    isRecovering || chatStatus === "submitted" || chatStatus === "streaming";

  function askWorkersAi() {
    const content = prompt.trim();
    if (!content) {
      return;
    }

    sendMessage({
      role: "user",
      parts: [{ type: "text", text: content }],
    });
    setPrompt("");
  }

  async function rememberNote() {
    await appAgent.stub.remember(agentNote);
    await addDecision(agentNote);
    setAgentNote("");
  }

  async function summarizeNotes() {
    await appAgent.stub.summarize();
  }

  async function clearNotes() {
    await appAgent.stub.clear();
  }

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100">
      <section className="mx-auto grid w-full max-w-6xl gap-6 px-4 py-8 md:grid-cols-[1.1fr_0.9fr]">
        <div className="flex min-h-[calc(100vh-4rem)] flex-col justify-center">
          <div className="mb-6 flex items-center gap-3 text-sm font-medium text-cyan-200">
            <Cloud className="size-5" />
            TanStack Start on Cloudflare Workers
          </div>
          <h1 className="text-balance text-4xl font-bold leading-tight tracking-normal md:text-6xl">
            Build with Workers AI and durable Cloudflare Agents.
          </h1>
          <p className="mt-5 max-w-2xl text-lg leading-8 text-slate-300">
            This Ghostbuild template ships as a TanStack Start app, deploys as a
            Cloudflare Worker, binds Workers AI, and registers a stateful Agent
            Durable Object.
          </p>
          <div className="mt-8 grid gap-3 text-sm text-slate-300 sm:grid-cols-3">
            <StackBadge
              icon={<Bot className="size-4" />}
              label={WORKERS_AI_CODING_MODEL}
            />
            <StackBadge
              icon={<DatabaseZap className="size-4" />}
              label="Cloudflare Agents"
            />
            <StackBadge
              icon={<Cloud className="size-4" />}
              label="wrangler deploy"
            />
          </div>
        </div>

        <div className="flex flex-col justify-center gap-4">
          <section className="rounded-lg border border-slate-800 bg-slate-900 p-4 shadow-2xl shadow-cyan-950/20">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-base font-semibold">Workers AI</h2>
              <span className="rounded-full bg-cyan-400/10 px-2.5 py-1 text-xs text-cyan-200">
                GLM 5.2
              </span>
            </div>
            <textarea
              className="min-h-28 w-full resize-none rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none ring-cyan-400/30 transition focus:ring-2"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
            <button
              className="mt-3 inline-flex h-10 items-center gap-2 rounded-md bg-cyan-300 px-4 text-sm font-semibold text-slate-950 transition hover:bg-cyan-200 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={!agentReady || isAsking || !prompt.trim()}
              onClick={askWorkersAi}
            >
              {isAsking ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Send className="size-4" />
              )}
              {isRecovering ? "Recovering..." : "Ask model"}
            </button>
            {isRecovering && (
              <span className="ml-2 text-sm text-cyan-200">
                Durable Agent recovery is resuming the interrupted turn.
              </span>
            )}
            {isAsking && (
              <button
                className="ml-2 inline-flex h-10 items-center rounded-md border border-slate-700 px-3 text-sm text-slate-200 transition hover:bg-slate-800"
                onClick={stop}
              >
                Stop
              </button>
            )}
            {aiMessages.length > 0 && (
              <div className="mt-4 max-h-72 space-y-3 overflow-auto rounded-md bg-slate-950 p-3 text-sm text-slate-200">
                {aiMessages.map((message) => (
                  <div key={message.id}>
                    <div className="mb-1 text-xs uppercase tracking-normal text-slate-500">
                      {message.role}
                    </div>
                    <div className="whitespace-pre-wrap">
                      {message.parts.map((part, index) =>
                        part.type === "text" ? (
                          <span key={index}>{part.text}</span>
                        ) : null,
                      )}
                    </div>
                  </div>
                ))}
                <button
                  className="rounded-md border border-slate-700 px-2.5 py-1.5 text-xs text-slate-300 transition hover:bg-slate-800"
                  onClick={clearHistory}
                >
                  Clear chat
                </button>
              </div>
            )}
          </section>

          <section className="rounded-lg border border-slate-800 bg-slate-900 p-4 shadow-2xl shadow-cyan-950/20">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-base font-semibold">Agent memory</h2>
              <span className="rounded-full bg-emerald-400/10 px-2.5 py-1 text-xs text-emerald-200">
                {agentReady ? "connected" : "connecting"}
              </span>
            </div>
            <div className="flex gap-2">
              <input
                className="min-w-0 flex-1 rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none ring-emerald-400/30 transition focus:ring-2"
                value={agentNote}
                onChange={(event) => setAgentNote(event.target.value)}
              />
              <button
                className="inline-flex h-10 items-center rounded-md bg-emerald-300 px-3 text-sm font-semibold text-slate-950 transition hover:bg-emerald-200 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={!agentReady || !agentNote.trim()}
                onClick={rememberNote}
              >
                Save
              </button>
            </div>
            <div className="mt-3 flex gap-2">
              <button
                className="rounded-md border border-slate-700 px-3 py-2 text-sm text-slate-200 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={!agentReady || agentState.notes.length === 0}
                onClick={summarizeNotes}
              >
                Summarize
              </button>
              <button
                className="inline-flex items-center gap-2 rounded-md border border-slate-700 px-3 py-2 text-sm text-slate-200 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                disabled={!agentReady || agentState.notes.length === 0}
                onClick={clearNotes}
              >
                <Trash2 className="size-4" />
                Clear
              </button>
            </div>
            <ul className="mt-4 space-y-2 text-sm text-slate-300">
              {agentState.notes.length === 0 ? (
                <li className="text-slate-500">No durable notes yet.</li>
              ) : (
                agentState.notes.map((note, index) => (
                  <li
                    key={`${note}-${index}`}
                    className="rounded-md bg-slate-950 px-3 py-2"
                  >
                    {note}
                  </li>
                ))
              )}
            </ul>
            {agentState.lastSummary && (
              <p className="mt-3 rounded-md border border-emerald-400/20 bg-emerald-400/10 p-3 text-sm text-emerald-100">
                {agentState.lastSummary}
              </p>
            )}
            <div className="mt-4 border-t border-slate-800 pt-4">
              <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-200">
                <DatabaseZap className="size-4 text-cyan-200" />
                D1-backed TanStack DB decisions
              </div>
              <ul className="space-y-2 text-sm text-slate-300">
                {decisionsLoading ? (
                  <li className="text-slate-500">Loading decisions...</li>
                ) : (
                  decisions.map((decision) => (
                    <li
                      key={decision.id}
                      className="rounded-md bg-slate-950 px-3 py-2"
                    >
                      <span className="font-medium text-slate-100">
                        {decision.title}:{" "}
                      </span>
                      {decision.detail}
                    </li>
                  ))
                )}
              </ul>
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}

function StackBadge({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-slate-800 bg-slate-900/80 px-3 py-2">
      <span className="text-cyan-200">{icon}</span>
      <span className="truncate">{label}</span>
    </div>
  );
}
