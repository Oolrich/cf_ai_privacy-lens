import { useAgentChat } from "@cloudflare/ai-chat/react";
import { useAgent } from "agents/react";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import ReactMarkdown from "react-markdown";
import type { AnalysisJob, PolicyAgentState, PolicySummary } from "../shared";

const STARTERS = [
  "Analyze https://www.cloudflare.com/privacypolicy/",
  "What should I look for in a privacy policy?",
  "Which of the policies I've read is riskiest?",
];

function getUserId(): string {
  const key = "privacy-lens:user";
  try {
    let id = localStorage.getItem(key);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(key, id);
    }
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

export default function App() {
  const [userId] = useState(getUserId);
  const [agentState, setAgentState] = useState<PolicyAgentState>({ library: [], jobs: {} });
  const agent = useAgent({
    agent: "PolicyAgent",
    name: userId,
    onStateUpdate: (state) => setAgentState(state as PolicyAgentState),
  });
  const { messages, sendMessage, status, stop, clearHistory } = useAgentChat({ agent });

  const [draft, setDraft] = useState("");
  const busy = status === "submitted" || status === "streaming";
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    sendMessage({ text: trimmed });
    setDraft("");
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send(draft);
    }
  }

  const jobs = Object.entries(agentState.jobs);

  return (
    <div className="app">
      <aside className="shelf">
        <p className="wordmark">Privacy Lens</p>

        <section aria-labelledby="library-heading">
          <h2 id="library-heading">Policies you've read</h2>
          {jobs.map(([id, job]) => (
            <JobRow key={id} job={job} />
          ))}
          {agentState.library.length === 0 && jobs.length === 0 ? (
            <p className="quiet">Nothing yet. Paste a link to a privacy policy to start.</p>
          ) : (
            <ul className="library">
              {agentState.library.map((policy) => (
                <li key={policy.id}>
                  <PolicyRow
                    policy={policy}
                    onOpen={() => send(`What are the main concerns in ${policy.company}'s policy (${policy.url})?`)}
                  />
                </li>
              ))}
            </ul>
          )}
        </section>

        <McpPanel />
      </aside>

      <main className="conversation">
        <div className="transcript" aria-live="polite">
          {messages.length === 0 ? (
            <div className="intro">
              <h1>Find out what a privacy policy lets a company do with your data.</h1>
              <p>
                Paste a link to any privacy policy. Privacy Lens reads every section, scores the
                risk, and highlights the exact clauses that matter so you can check them yourself.
              </p>
              <div className="starters">
                {STARTERS.map((starter) => (
                  <button key={starter} type="button" onClick={() => send(starter)}>
                    {starter}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((message) => <MessageView key={message.id} message={message} />)
          )}
          {status === "submitted" && <p className="thinking">Thinking…</p>}
          {status === "error" && (
            <p className="error">The agent didn't respond. Check your connection and send again.</p>
          )}
          <div ref={endRef} />
        </div>

        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            send(draft);
          }}
        >
          <label htmlFor="message" className="visually-hidden">
            Message
          </label>
          <textarea
            id="message"
            rows={2}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Paste a privacy policy link or ask about one you've read"
          />
          <div className="composer-actions">
            {messages.length > 0 && (
              <button type="button" className="text-button" onClick={() => clearHistory()}>
                Clear conversation
              </button>
            )}
            {busy ? (
              <button type="button" onClick={() => stop()}>
                Stop
              </button>
            ) : (
              <button type="submit" disabled={!draft.trim()}>
                Send
              </button>
            )}
          </div>
        </form>
      </main>
    </div>
  );
}

function riskLevel(score: number) {
  return score >= 7 ? "high" : score >= 4 ? "mid" : "low";
}

function PolicyRow({ policy, onOpen }: { policy: PolicySummary; onOpen: () => void }) {
  return (
    <button type="button" className="policy" onClick={onOpen}>
      <span className="risk" data-level={riskLevel(policy.riskScore)} aria-label={`Risk ${policy.riskScore} out of 10`}>
        {policy.riskScore}
      </span>
      <span className="policy-text">
        <span className="policy-name">{policy.company}</span>
        <span className="policy-host">{hostOf(policy.url)}</span>
      </span>
    </button>
  );
}

function JobRow({ job }: { job: AnalysisJob }) {
  const percent = Math.round(job.percent * 100);
  return (
    <div className="job">
      <span className="policy-name">{hostOf(job.url)}</span>
      <span className="policy-host">{job.message}</span>
      <div
        className="meter"
        role="progressbar"
        aria-label={`Reading ${hostOf(job.url)}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <span style={{ width: `${Math.max(percent, 3)}%` }} />
      </div>
    </div>
  );
}

function McpPanel() {
  const [copied, setCopied] = useState(false);
  const address = `${window.location.origin}/mcp`;
  return (
    <section className="mcp" aria-labelledby="mcp-heading">
      <h2 id="mcp-heading">Use from other AI tools</h2>
      <p className="quiet">
        Connect any MCP client, such as Claude or Cursor, to this address to read reports and
        request new analyses.
      </p>
      <code>{address}</code>
      <button
        type="button"
        className="text-button"
        onClick={async () => {
          await navigator.clipboard.writeText(address);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
      >
        {copied ? "Copied" : "Copy address"}
      </button>
    </section>
  );
}

const TOOL_LABELS: Record<string, [running: string, done: string]> = {
  analyze_policy: ["Checking the policy", "Checked the policy"],
  get_report: ["Reading the report", "Read the report"],
  compare_policies: ["Comparing policies", "Compared policies"],
};

function MessageView({ message }: { message: UIMessage }) {
  return (
    <article className={`message message-${message.role}`}>
      {message.parts.map((part, index) => {
        if (part.type === "text") {
          return message.role === "assistant" ? (
            <div className="prose" key={index}>
              <ReactMarkdown components={{ strong: ({ children }) => <mark>{children}</mark> }}>
                {part.text}
              </ReactMarkdown>
            </div>
          ) : (
            <p key={index}>{part.text}</p>
          );
        }
        if (isToolUIPart(part)) {
          const name = getToolName(part);
          const [running, done] = TOOL_LABELS[name] ?? [`Running ${name}`, `Ran ${name}`];
          const label =
            part.state === "output-error" ? `${running} failed` : part.state === "output-available" ? done : `${running}…`;
          return (
            <p className="tool" key={index}>
              {label}
            </p>
          );
        }
        return null;
      })}
    </article>
  );
}
