import { useAgentChat } from "@cloudflare/ai-chat/react";
import { createFileRoute, useHydrated } from "@tanstack/react-router";
import { useAgent } from "agents/react";
import { useEffect, useState, type FormEvent } from "react";
import { WORKERS_AI_CODING_MODEL } from "../workers-ai.shared";
import { MAX_USER_MESSAGE_TEXT_CHARS } from "../agents/chat-policy";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  const hydrated = useHydrated();

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-10 text-slate-100">
      <div className="mx-auto grid w-full max-w-5xl gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:items-center">
        <section>
          <p className="text-sm font-semibold uppercase tracking-wider text-cyan-300">
            Ghostbuild on Cloudflare
          </p>
          <h1 className="mt-4 text-4xl font-bold leading-tight md:text-5xl">
            Start with a durable AI agent.
          </h1>
          <p className="mt-5 max-w-xl leading-7 text-slate-300">
            A minimal TanStack Start application running on Cloudflare Workers,
            with Workers AI and a Cloudflare Agent ready to extend.
          </p>
          <div className="mt-6 flex flex-wrap gap-2 text-xs text-slate-300">
            <span className="rounded-full border border-slate-700 px-3 py-1.5">
              {WORKERS_AI_CODING_MODEL}
            </span>
            <span className="rounded-full border border-slate-700 px-3 py-1.5">
              Durable Objects
            </span>
            <span className="rounded-full border border-slate-700 px-3 py-1.5">
              D1 + R2 ready
            </span>
          </div>
        </section>

        {hydrated ? <AgentSessionGate /> : <AgentChatPlaceholder />}
      </div>
    </main>
  );
}

function AgentSessionGate() {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/agent/session", {
      method: "POST",
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) {
          throw new Error(
            `Unable to create agent session (${response.status}).`,
          );
        }
        setState("ready");
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          console.error("Unable to initialize agent session", error);
          setState("error");
        }
      });
    return () => controller.abort();
  }, []);

  if (state === "ready") {
    return <AgentChat />;
  }
  return <AgentChatPlaceholder failed={state === "error"} />;
}

function AgentChat() {
  const [prompt, setPrompt] = useState("");
  const appAgent = useAgent({ agent: "AppAgent", basePath: "agent" });
  const { messages, sendMessage, clearHistory, status, stop, isRecovering } =
    useAgentChat({ agent: appAgent });
  const isResponding =
    isRecovering || status === "submitted" || status === "streaming";

  function submitPrompt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = prompt.trim();
    if (!text || isResponding || appAgent.connectionError) {
      return;
    }

    sendMessage({
      role: "user",
      parts: [{ type: "text", text }],
    });
    setPrompt("");
  }

  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900 p-5 shadow-2xl shadow-cyan-950/20">
      <div className="flex items-center justify-between gap-4">
        <h2 className="font-semibold">App Agent</h2>
        <span className="text-xs text-slate-400">
          {appAgent.connectionError
            ? "Connection error"
            : isRecovering
              ? "Recovering"
              : isResponding
                ? "Responding"
                : "Ready"}
        </span>
      </div>

      <div
        className="mt-4 h-80 space-y-4 overflow-y-auto rounded-lg bg-slate-950 p-4"
        aria-live="polite"
      >
        {messages.length === 0 ? (
          <p className="text-sm leading-6 text-slate-500">
            Ask the agent about your application to begin.
          </p>
        ) : (
          messages.map((message) => (
            <article key={message.id} className="text-sm">
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">
                {message.role}
              </p>
              <div className="whitespace-pre-wrap leading-6 text-slate-200">
                {message.parts.map((part, index) =>
                  part.type === "text" ? (
                    <span key={index}>{part.text}</span>
                  ) : null,
                )}
              </div>
            </article>
          ))
        )}
      </div>

      {appAgent.connectionError && (
        <p className="mt-3 text-sm text-red-300">
          The agent connection failed. Refresh the page to reconnect.
        </p>
      )}

      <form className="mt-4" onSubmit={submitPrompt}>
        <label className="sr-only" htmlFor="agent-prompt">
          Message the app agent
        </label>
        <textarea
          id="agent-prompt"
          className="min-h-24 w-full resize-none rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm outline-none ring-cyan-400/30 transition focus:ring-2"
          value={prompt}
          maxLength={MAX_USER_MESSAGE_TEXT_CHARS}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="How should I structure my first feature?"
        />
        <div className="mt-3 flex items-center gap-2">
          <button
            type="submit"
            className="rounded-md bg-cyan-300 px-4 py-2 text-sm font-semibold text-slate-950 transition hover:bg-cyan-200 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={
              !prompt.trim() || isResponding || !!appAgent.connectionError
            }
          >
            Send
          </button>
          {isResponding && (
            <button
              type="button"
              className="rounded-md border border-slate-700 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800"
              onClick={stop}
            >
              Stop
            </button>
          )}
          {messages.length > 0 && !isResponding && (
            <button
              type="button"
              className="ml-auto px-2 py-2 text-sm text-slate-400 hover:text-slate-200"
              onClick={clearHistory}
            >
              Clear chat
            </button>
          )}
        </div>
      </form>
    </section>
  );
}

function AgentChatPlaceholder({ failed = false }: { failed?: boolean }) {
  return (
    <section className="rounded-xl border border-slate-800 bg-slate-900 p-5 shadow-2xl shadow-cyan-950/20">
      <h2 className="font-semibold">App Agent</h2>
      <div className="mt-4 flex h-80 items-center justify-center rounded-lg bg-slate-950 p-4">
        <p
          className={failed ? "text-sm text-red-300" : "text-sm text-slate-500"}
        >
          {failed
            ? "The agent session could not be started. Refresh to try again."
            : "Connecting to your session…"}
        </p>
      </div>
    </section>
  );
}
