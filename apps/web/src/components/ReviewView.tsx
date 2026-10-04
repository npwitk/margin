import { useEffect, useState } from "react";
import type { AiSettings, Project, ReviewIssue, ReviewSkill } from "@margin/shared";
import { api, type StoredReview } from "../lib/api.ts";
import { relativeTime } from "../lib/time.ts";
import { Icon, Spinner } from "./Icon.tsx";

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
      const r = await api.startReview(project.id, skill, goal);
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
            {skills.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <p className="muted small">{skills.find((s) => s.id === skill)?.description}</p>
          {noKey ? (
            <button className="btn primary block" onClick={onOpenSettings}>Add API key to review</button>
          ) : (
            <button className="btn primary block" onClick={run} disabled={reviews.some((r) => r.status === "running")}>
              {reviews.some((r) => r.status === "running") ? <><Spinner /> Reviewing…</> : <>✦ Review the paper</>}
            </button>
          )}
          <p className="muted small">Claude reads the whole paper and bibliography. A review takes about a minute.</p>
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
        {current?.status === "running" && <div className="empty"><Spinner size={18} /><p>Claude is reading the paper…</p></div>}
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
                <p className="small">{c.assessment}</p>
                {c.issues.map((issue, ii) => {
                  const key = `${current!.id}-${ci}-${ii}`;
                  return (
                    <div key={ii} className="issue">
                      <span className={`sev-dot ${issue.severity}`} title={`${issue.severity} priority`} />
                      <div className="grow">
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
          </>
        )}
      </main>
    </div>
  );
}
