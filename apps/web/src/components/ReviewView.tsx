import { useEffect, useState } from "react";
import type { AiSettings, Project, ReviewIssue, ReviewSkill } from "@margin/shared";
import { api, type StoredReview } from "../lib/api.ts";
import { relativeTime } from "../lib/time.ts";
import { Icon, Spinner } from "./Icon.tsx";
import { renderMarkdown } from "../lib/markdown.ts";
import { useConnect } from "../lib/connect.ts";
import { load, save } from "../lib/storage.ts";

interface Props {
  project: Project;
  settings: AiSettings | null;
  onProjectChange(p: Project): void;
  onOpenSettings(): void;
  onOpen(path: string, line?: number): void;
  notify(msg: string): void;
}

const READINESS: Record<string, string> = { "not ready": "Not ready", "major revision": "Major revision", "minor revision": "Minor revision", ready: "Ready to submit" };

export function ReviewView({ project, settings, onProjectChange, onOpenSettings, onOpen, notify }: Props) {
  const [skills, setSkills] = useState<ReviewSkill[]>([]);
  const [skill, setSkill] = useState("general");
  const [goal, setGoal] = useState(project.goal ?? "");
  const [reviews, setReviews] = useState<StoredReview[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [commented, setCommented] = useState<Set<string>>(new Set());
  // Who runs the review: Margin with an API key, or your own agent through Margin Connect.
  const connect = useConnect(project.id);
  const agents = connect.devices.flatMap((d) => d.agents.filter((a) => a.available).map((a) => ({ value: `${d.id}|${a.id}`, label: `${a.name} · ${d.name}`, deviceId: d.id, agentId: a.id })));
  const [runnerValue, setRunnerValue] = useState<string>(() => load("reviewRunner", "api"));
  useEffect(() => save("reviewRunner", runnerValue), [runnerValue]);
  const runner = agents.find((a) => a.value === runnerValue);

  const refresh = async () => {
    const list = await api.reviews(project.id);
    setReviews(list);
    return list;
  };

  useEffect(() => {
    void api.skills(project.id).then((s) => {
      setSkills(s);
      // Guess a rubric from the goal.
      const g = (project.goal ?? "").toLowerCase();
      if (/neurips|icml|iclr|aaai|acl|emnlp|cvpr/.test(g)) setSkill("ml-conference");
      else if (/ieee/.test(g)) setSkill("ieee-conference");
      else if (/thesis|dissertation/.test(g)) setSkill("thesis");
      else if (/journal|transactions/.test(g)) setSkill("journal");
    });
    void refresh().then((l) => setSelected((s) => s ?? l[0]?.id ?? null));
  }, [project.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll while a review is running.
  useEffect(() => {
    if (!reviews.some((r) => r.status === "running")) return;
    const t = window.setInterval(() => void refresh(), 2000);
    return () => window.clearInterval(t);
  }, [reviews]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveGoal = async () => {
    if ((project.goal ?? "") !== goal.trim()) onProjectChange(await api.updateProject(project.id, { goal: goal.trim() }));
  };

  const run = async () => {
    try {
      await saveGoal();
      const r = await api.startReview(project.id, skill, goal, runner ? { deviceId: runner.deviceId, agentId: runner.agentId } : undefined);
      setSelected(r.id);
      await refresh();
    } catch (err) {
      notify((err as Error).message);
    }
  };

  const comment = async (issue: ReviewIssue, key: string) => {
    if (!issue.file) return;
    try {
      await api.addThread(project.id, { path: issue.file, quote: issue.quote, kind: "comment", message: `${issue.problem}\n\nSuggestion: ${issue.suggestion} (AI review)` });
      setCommented((s) => new Set(s).add(key));
      notify(`Comment added to ${issue.file}`);
    } catch (err) {
      notify((err as Error).message);
    }
  };

  const current = reviews.find((r) => r.id === selected) ?? null;
  const noKey = settings && !settings.hasKey && !settings.shared;
  const result = current?.status === "done" ? current.result : undefined;

  return (
    <div className="review-view">
      <aside className="review-side">
        <div className="card">
          <label className="field-label">Publishing goal</label>
          <input className="input" placeholder="e.g. NeurIPS 2027 main track, Q1 journal, MSc thesis" value={goal} onChange={(e) => setGoal(e.target.value)} onBlur={() => void saveGoal()} />
          <label className="field-label">Review rubric</label>
          <select value={skill} onChange={(e) => setSkill(e.target.value)}>
            <optgroup label="Review panels (several reviewers)">
              {skills.filter((s) => s.kind === "panel").map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </optgroup>
            <optgroup label="Single reviewer with a venue rubric">
              {skills.filter((s) => s.kind !== "panel").map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </optgroup>
          </select>
          <p className="muted small">{skills.find((s) => s.id === skill)?.description}</p>
          {skills.find((s) => s.id === skill)?.credit && <p className="muted tiny">{skills.find((s) => s.id === skill)!.credit}</p>}
          <label className="field-label">Run with</label>
          <select value={runner ? runner.value : "api"} onChange={(e) => setRunnerValue(e.target.value)}>
            <option value="api">Margin · your Anthropic API key</option>
            {agents.map((a) => <option key={a.value} value={a.value}>{a.label} · your subscription</option>)}
          </select>
          {!agents.length && <p className="muted tiny">Connect Claude Code or Codex (Assistant → “Use Claude Code or Codex…”) to review with your own subscription. Claude Code runs the reviewers as parallel subagents.</p>}
          {noKey && !runner ? (
            <button className="btn primary block" onClick={onOpenSettings}>Add API key to review</button>
          ) : (
            <button className="btn primary block" onClick={run} disabled={reviews.some((r) => r.status === "running")}>
              {reviews.some((r) => r.status === "running") ? <><Spinner /> Reviewing…</> : <>✦ Review the paper</>}
            </button>
          )}
          <p className="muted small">{(() => {
            const sk = skills.find((x) => x.id === skill);
            return sk?.kind === "panel"
              ? `${sk.reviewers} reviewers read the whole paper and bibliography in parallel; the paper is cached, so the extra reviewers cost far less than ${sk.reviewers} full reads. The report is also saved to reviews/.`
              : "Claude reads the whole paper and bibliography. A review takes about a minute.";
          })()}</p>
        </div>
        {reviews.length > 0 && (
          <div className="review-history">
            <div className="section-label">History</div>
            {reviews.map((r) => (
              <button key={r.id} className={`history-row ${r.id === selected ? "active" : ""}`} onClick={() => setSelected(r.id)}>
                <span className={`score-pill s${Math.round((r.result?.overall_score ?? 0) / 2)}`}>{r.status === "running" ? <Spinner size={10} /> : r.status === "error" ? "!" : r.result?.overall_score}</span>
                <div className="grow">
                  <div className="small">{skills.find((s) => s.id === r.skill)?.name ?? r.skill}</div>
                  <div className="muted small">{r.by} · {relativeTime(r.at)}</div>
                </div>
              </button>
            ))}
          </div>
        )}
      </aside>

      <main className="review-main">
        {!current && <div className="empty">Set your goal and run a review to see how ready the paper is, with scores per criterion and concrete fixes.</div>}
        {current?.status === "running" && current.runner && (
          <AgentRunView review={current} connect={connect} onStop={() => void api.cancelReview(project.id, current.id)} />
        )}
        {current?.status === "running" && !current.runner && (
          <div className="empty">
            <Spinner size={18} />
            {current.progress ? (
              <>
                <p>{current.progress.done.length} of {current.progress.total} reviewers done</p>
                <div className="panel-progress">
                  {current.progress.done.map((d) => <span key={d} className="chip"><Icon name="check" size={11} />{d}</span>)}
                  {current.progress.running.map((d) => <span key={d} className="chip active"><Spinner size={9} />{d}</span>)}
                </div>
              </>
            ) : <p>Claude is reading the paper…</p>}
          </div>
        )}
        {current?.status === "error" && <div className="empty error">{current.error}</div>}
        {result && (
          <>
            <header className="verdict">
              <div className={`big-score s${Math.round(result.overall_score / 2)}`}>{result.overall_score}<span>/10</span></div>
              <div className="grow">
                <div className={`readiness ${result.readiness.replace(" ", "-")}`}>{READINESS[result.readiness] ?? result.readiness}</div>
                <div className="muted small">for {current!.goal}</div>
                <p>{result.summary}</p>
              </div>
            </header>
            {result.panel && (
              <div className="panel-chips">
                {result.panel.recommendation && <span className={`rec-chip ${result.panel.recommendation.replace(/ /g, "-")}`}>{result.panel.recommendation}</span>}
                <span className="sev-chip critical">{result.panel.counts.critical} critical</span>
                <span className="sev-chip major">{result.panel.counts.major} major</span>
                <span className="sev-chip minor">{result.panel.counts.minor} minor</span>
                <div className="spacer" />
                {result.panel.report && <button className="btn" onClick={() => onOpen(result.panel!.report!)}><Icon name="file" size={13} />Open full report</button>}
              </div>
            )}
            {result.panel?.failed.length ? <p className="error small">These reviewers didn't return a result: {result.panel.failed.join(", ")}. Their sections are placeholders.</p> : null}
            {result.panel?.contribution && (
              <section className="card contribution">
                <div className="section-label">Central contribution</div>
                <div className="two-col">
                  {(["advocate", "skeptic"] as const).map((side) => {
                    const c = result.panel!.contribution![side];
                    return c ? (
                      <div key={side} className={`side ${side}`}>
                        <div className="side-head"><strong>{side === "advocate" ? "Advocate" : "Skeptic"}</strong><span className={`rating ${c.rating}`}>{c.rating}</span></div>
                        <p className="small">{c.justification}</p>
                      </div>
                    ) : null;
                  })}
                </div>
                {result.panel.contribution.crux && <p className="small"><strong>Crux:</strong> {result.panel.contribution.crux}</p>}
                {result.panel.contribution.synthesis && <p className="small muted">{result.panel.contribution.synthesis}</p>}
              </section>
            )}
            <div className="two-col">
              <section className="card">
                <div className="section-label">Top priorities</div>
                <ol>{result.top_priorities.map((p, i) => <li key={i}>{p}</li>)}</ol>
              </section>
              <section className="card">
                <div className="section-label">Strengths</div>
                <ul>{result.strengths.map((p, i) => <li key={i}>{p}</li>)}</ul>
              </section>
            </div>
            {result.criteria.map((c, ci) => (
              <section key={ci} className="card criterion">
                <div className="criterion-head">
                  <span className="criterion-name">{c.name}</span>
                  <div className="bar"><div className={`fill-bar s${Math.round(c.score / 2)}`} style={{ width: `${c.score * 10}%` }} /></div>
                  <span className="criterion-score">{c.score}</span>
                </div>
                <div className="small md criterion-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(c.assessment) }} />
                {c.issues.map((issue, ii) => {
                  const key = `${current!.id}-${ci}-${ii}`;
                  return (
                    <div key={ii} className="issue">
                      <span className={`sev-dot ${issue.severity}`} title={`${issue.severity} priority`} />
                      <div className="grow">
                        {issue.tag && <span className={`sev-chip ${issue.tag.toLowerCase()}`}>{issue.tag}</span>}{issue.location && <span className="muted small"> {issue.location}</span>}
                        {issue.quote && <blockquote className="quote">{issue.quote}</blockquote>}
                        <div className="small"><strong>{issue.problem}</strong></div>
                        <div className="small muted">{issue.suggestion}</div>
                      </div>
                      {issue.file && (
                        <div className="issue-actions">
                          <button className="btn ghost tight" onClick={() => onOpen(issue.file!, issue.line)}>{issue.file.split("/").pop()}:{issue.line}</button>
                          <button className="btn ghost tight" disabled={commented.has(key)} onClick={() => void comment(issue, key)}>
                            <Icon name={commented.has(key) ? "check" : "comment"} size={12} />{commented.has(key) ? "Commented" : "Comment"}
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </section>
            ))}
            {result.panel && result.panel.questions.length > 0 && (
              <section className="card">
                <div className="section-label">Questions a referee would ask</div>
                <ol>{result.panel.questions.map((q, i) => <li key={i}>{q}</li>)}</ol>
              </section>
            )}
            {result.panel?.credit && <p className="muted tiny">{result.panel.credit}</p>}
          </>
        )}
      </main>
    </div>
  );
}


/** A review running on your own agent: what it's doing, and any permission it needs. */
function AgentRunView({ review, connect, onStop }: { review: StoredReview; connect: ReturnType<typeof useConnect>; onStop(): void }) {
  const r = review.runner!;
  useEffect(() => { connect.openThread(r.threadId); }, [r.threadId]); // eslint-disable-line react-hooks/exhaustive-deps
  const thread = connect.open[r.threadId];
  const pending = thread?.entries.filter((e) => e.type === "permission" && !e.done) as Extract<NonNullable<typeof thread>["entries"][number], { type: "permission" }>[] | undefined;
  return (
    <div className="empty agent-run">
      <Spinner size={18} />
      <p><strong>{r.agent}</strong> on {r.device} is reviewing the paper{r.agent.startsWith("Claude") ? " with parallel subagents" : ""}.</p>
      <p className="muted small">This uses your {r.agent} subscription, not an API key. A full panel can take several minutes.</p>
      {pending?.map((p) => (
        <div key={p.requestId} className="permission">
          <div><strong>{r.agent}</strong> wants to: {p.title}</div>
          <div className="row gap">
            {p.options.map((o) => (
              <button key={o.optionId} className={`btn tight ${o.kind.startsWith("allow") ? "primary" : ""}`}
                onClick={() => void connect.command(r.deviceId, { kind: "permission", threadId: r.threadId, requestId: p.requestId, optionId: o.optionId })}>{o.name}</button>
            ))}
          </div>
        </div>
      ))}
      {review.activity?.length ? <div className="activity">{review.activity.map((a, i) => <div key={i} className="tool-row completed"><Icon name="check" size={11} /><span className="ellipsis">{a}</span></div>)}</div> : null}
      <button className="btn ghost" onClick={onStop}>Stop</button>
    </div>
  );
}
