// SPDX-FileCopyrightText: 2026 WithVibe
// SPDX-License-Identifier: Apache-2.0

import { getFullPlan } from "./db.js";

export function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const TASK_PILL = {
  pending: { label: "pending", cls: "pill pill-muted" },
  in_progress: { label: "in progress", cls: "pill pill-primary" },
  done: { label: "done", cls: "pill pill-success" },
  blocked: { label: "blocked", cls: "pill pill-warning" },
  deferred: { label: "deferred", cls: "pill pill-muted" },
  canceled: { label: "canceled", cls: "pill pill-muted strike" },
};
const PHASE_PILL = {
  pending: { label: "pending", cls: "pill pill-muted" },
  in_progress: { label: "in progress", cls: "pill pill-primary" },
  done: { label: "done", cls: "pill pill-success" },
};

function renderProgressBar(done, total) {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return `<div class="progress"><div class="progress-fill" style="width:${pct}%"></div></div>
<span class="progress-text">${done}/${total}</span>`;
}

function renderActiveBanner(active, plan) {
  if (!active.task) {
    if (!plan.phases.length)
      return `<div class="active-banner active-empty">No roadmap yet — the AI will propose one when you start.</div>`;
    return `<div class="active-banner active-empty">No active task. Pick one below or ask the AI to set one.</div>`;
  }
  const t = active.task;
  const p = active.phase;
  return `<div class="active-banner">
    <span class="active-dot"></span>
    <div class="active-text">
      <span class="active-label">you are here</span>
      ${p ? `<span class="active-phase">${escapeHtml(p.title)}</span><span class="sep">›</span>` : ""}
      <span class="active-task">${escapeHtml(t.title)}</span>
    </div>
    <button class="btn btn-ghost btn-sm" hx-post="ui/task/${t.id}/complete" hx-target="#app" hx-swap="innerHTML">mark done</button>
  </div>`;
}

function renderTask(task, activeId) {
  const isActive = String(task.id) === String(activeId);
  const pill = TASK_PILL[task.status] || TASK_PILL.pending;
  const desc = task.description
    ? `<div class="task-desc">${escapeHtml(task.description)}</div>`
    : "";
  const outcome = task.outcome
    ? `<div class="task-outcome">→ ${escapeHtml(task.outcome)}</div>`
    : "";
  const notes = task.notes_md
    ? `<details class="task-notes"><summary>notes</summary><pre>${escapeHtml(task.notes_md)}</pre></details>`
    : "";
  const setActiveBtn =
    task.status !== "done" && task.status !== "canceled" && !isActive
      ? `<button class="btn btn-sm btn-ghost" hx-post="ui/task/${task.id}/active" hx-target="#app" hx-swap="innerHTML" title="Mark as the currently active task">set active</button>`
      : "";
  const doneBtn =
    task.status !== "done" && task.status !== "canceled"
      ? `<button class="btn btn-sm btn-ghost" hx-post="ui/task/${task.id}/complete" hx-target="#app" hx-swap="innerHTML">done</button>`
      : "";
  const statusMenu = `
    <select class="status-menu" hx-post="ui/task/${task.id}/status" hx-target="#app" hx-swap="innerHTML" name="status" hx-trigger="change">
      ${["pending", "in_progress", "blocked", "deferred", "canceled", "done"]
        .map(
          (s) =>
            `<option value="${s}" ${task.status === s ? "selected" : ""}>${s.replace("_", " ")}</option>`
        )
        .join("")}
    </select>`;
  return `<li class="task ${isActive ? "task-active" : ""} task-${task.status}">
    <div class="task-head">
      <span class="${pill.cls}">${pill.label}</span>
      <span class="task-id">#${task.id}</span>
      <span class="task-title">${escapeHtml(task.title)}</span>
      <span class="task-actions">${setActiveBtn} ${doneBtn} ${statusMenu}</span>
    </div>
    ${desc}
    ${outcome}
    ${notes}
  </li>`;
}

function renderPhase(phase, activeId) {
  const pill = PHASE_PILL[phase.status] || PHASE_PILL.pending;
  const summary = phase.summary
    ? `<div class="phase-summary">${escapeHtml(phase.summary)}</div>`
    : "";
  const tasks = phase.tasks
    .map((t) => renderTask(t, activeId))
    .join("");
  const emptyTasks =
    phase.tasks.length === 0
      ? `<li class="task-empty">No tasks yet in this phase.</li>`
      : "";
  // hx-preserve keeps the form (and any half-typed input) untouched when the
  // 4s poll swaps #app — otherwise the input would be re-inserted on every
  // tick and could steal focus from the parent chat window.
  return `<section class="phase phase-${phase.status}">
    <header class="phase-head">
      <span class="${pill.cls}">${pill.label}</span>
      <h2 class="phase-title">${escapeHtml(phase.title)}</h2>
      <span class="phase-id">phase #${phase.id}</span>
    </header>
    ${summary}
    <ul class="task-list">${tasks}${emptyTasks}</ul>
    <form id="add-task-form-${phase.id}" hx-preserve="true" class="add-task" hx-post="ui/phase/${phase.id}/task" hx-target="#app" hx-swap="innerHTML" hx-on::after-request="this.reset()">
      <input name="title" placeholder="Add task to this phase…" required>
      <button class="btn btn-sm" type="submit">add</button>
    </form>
  </section>`;
}

function renderEvent(e) {
  const when = new Date(e.at).toISOString().slice(0, 16).replace("T", " ");
  const ref = e.ref_kind && e.ref_id ? `${e.ref_kind} #${e.ref_id}` : "";
  const reason = e.reason ? ` — ${escapeHtml(e.reason)}` : "";
  return `<li class="event event-${e.actor}">
    <span class="event-when">${when}</span>
    <span class="event-actor">${escapeHtml(e.actor)}</span>
    <span class="event-kind">${escapeHtml(e.kind)}</span>
    <span class="event-ref">${ref}</span>
    <span class="event-reason">${reason}</span>
  </li>`;
}

export async function renderApp() {
  const plan = await getFullPlan({ eventLimit: 30 });
  const title = plan.plan?.title || "Implementation";
  const summary = plan.plan?.summary
    ? `<p class="plan-summary">${escapeHtml(plan.plan.summary)}</p>`
    : "";
  const activeId = plan.plan?.active_task_id || null;
  const phasesHtml = plan.phases.map((p) => renderPhase(p, activeId)).join("");
  const eventsHtml = plan.events.map(renderEvent).join("");
  // No `autofocus` here — same-origin iframes can steal focus from the
  // parent chat window when the input is (re-)inserted on every poll tick.
  // The form is right there; the user can click it.
  const emptyState =
    plan.phases.length === 0
      ? `<div class="empty-state">
          <h3>No roadmap yet</h3>
          <p>The AI orchestrator can call <code>propose_plan</code> in chat to draft one,
             or you can start manually.</p>
          <form id="empty-add-phase-form" hx-preserve="true" hx-post="ui/phase" hx-target="#app" hx-swap="innerHTML" class="empty-form">
            <input name="title" placeholder="First phase title (e.g. Schema)" required>
            <button class="btn" type="submit">add phase</button>
          </form>
        </div>`
      : "";

  return `<div class="layout">
    <header class="topbar">
      <div class="topbar-left">
        <h1 class="plan-title">${escapeHtml(title)}</h1>
        ${summary}
      </div>
      <div class="topbar-right">
        ${renderProgressBar(plan.progress.done, plan.progress.total)}
      </div>
    </header>

    ${renderActiveBanner(plan.active, plan)}

    <div class="main">
      <section class="board">
        ${phasesHtml}
        ${emptyState}
        ${
          plan.phases.length > 0
            ? `<form id="add-phase-form" hx-preserve="true" class="add-phase" hx-post="ui/phase" hx-target="#app" hx-swap="innerHTML" hx-on::after-request="this.reset()">
                <input name="title" placeholder="New phase…" required>
                <button class="btn" type="submit">add phase</button>
              </form>`
            : ""
        }
      </section>

      <aside class="changelog">
        <h3>Plan changes</h3>
        <ul class="event-list">
          ${eventsHtml || `<li class="event-empty">No changes yet.</li>`}
        </ul>
      </aside>
    </div>
  </div>`;
}

// Full HTML shell. We poll a cheap /ui/version endpoint every 4s and only
// trigger a real swap when the version actually moved — blind innerHTML
// swaps were causing the iframe to "jump scroll" on every tick because the
// swap reflows / re-fires animations / re-runs htmx attribute setup on
// every nested element. The before/after scroll-save hooks cover the
// remaining case (legitimate swap after an AI change).
export function renderShell(inner) {
  return /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Roadmap</title>
<script src="https://unpkg.com/htmx.org@2.0.3"></script>
<style>${CSS}</style>
</head>
<body>
<main id="app" hx-get="ui/app" hx-trigger="data-change from:body" hx-swap="innerHTML focus-scroll:false show:none">
${inner}
</main>
<script>
(() => {
  let lastVersion = null;
  let savedScroll = 0;
  async function check() {
    try {
      const r = await fetch('ui/version', { cache: 'no-store' });
      if (!r.ok) return;
      const { version } = await r.json();
      if (lastVersion !== null && version !== lastVersion) {
        document.body.dispatchEvent(new CustomEvent('data-change'));
      }
      lastVersion = version;
    } catch (_) { /* network blip — try again next tick */ }
  }
  // Preserve scroll across the (now-rare) full swap so the user doesn't
  // get bumped when the AI updates the plan.
  document.body.addEventListener('htmx:beforeSwap', () => {
    savedScroll = window.scrollY || document.documentElement.scrollTop || 0;
  });
  document.body.addEventListener('htmx:afterSwap', () => {
    window.scrollTo(0, savedScroll);
  });
  setInterval(check, 4000);
  // First check right away so we capture the initial version without a 4s delay.
  void check();
})();
</script>
</body>
</html>`;
}

// WithVibe-aligned dark palette (mirrors apps/web/src/app/globals.css).
const CSS = `
:root {
  --bg: hsl(220 13% 12%);
  --card: hsl(220 13% 15%);
  --card-2: hsl(220 13% 18%);
  --border: hsl(220 13% 22%);
  --fg: hsl(0 0% 88%);
  --muted: hsl(0 0% 60%);
  --primary: hsl(207 90% 54%);
  --primary-soft: hsl(207 90% 54% / 0.12);
  --accent: hsl(177 48% 60%);
  --accent-soft: hsl(177 48% 60% / 0.12);
  --warning: hsl(45 100% 71%);
  --warning-soft: hsl(45 100% 71% / 0.14);
  --destructive: hsl(4 90% 58%);
  --radius: 8px;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
* { box-sizing: border-box; }
html, body { background: var(--bg); color: var(--fg); margin: 0; }
body { font: 13px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
h1, h2, h3 { font-family: var(--mono); letter-spacing: -0.02em; font-weight: 600; }

.layout { display: flex; flex-direction: column; min-height: 100vh; padding: 16px; gap: 12px; }

.topbar { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; padding-bottom: 8px; border-bottom: 1px solid var(--border); }
.topbar-left { min-width: 0; }
.plan-title { font-size: 16px; margin: 0 0 4px 0; }
.plan-summary { margin: 0; color: var(--muted); font-size: 12px; }
.topbar-right { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
.progress { width: 180px; height: 6px; background: var(--card-2); border-radius: 3px; overflow: hidden; }
.progress-fill { height: 100%; background: linear-gradient(90deg, var(--primary), var(--accent)); transition: width 300ms ease; }
.progress-text { color: var(--muted); font-family: var(--mono); font-size: 11px; }

.active-banner {
  display: flex; align-items: center; gap: 12px;
  padding: 10px 14px;
  background: var(--primary-soft);
  border: 1px solid hsl(207 90% 54% / 0.35);
  border-radius: var(--radius);
}
.active-banner.active-empty { background: var(--card); border-color: var(--border); color: var(--muted); justify-content: center; padding: 12px; }
.active-dot {
  width: 8px; height: 8px; border-radius: 50%; background: var(--primary);
  box-shadow: 0 0 0 0 hsl(207 90% 54% / 0.6);
  animation: pulse 2s ease-out infinite;
}
@keyframes pulse { 70% { box-shadow: 0 0 0 8px hsl(207 90% 54% / 0); } 100% { box-shadow: 0 0 0 0 hsl(207 90% 54% / 0); } }
.active-text { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; }
.active-label { font-family: var(--mono); font-size: 10px; text-transform: uppercase; color: var(--muted); letter-spacing: 0.08em; }
.active-phase { color: var(--muted); }
.active-task { font-weight: 600; color: var(--fg); }
.sep { color: var(--muted); }

.main { display: grid; grid-template-columns: minmax(0, 2fr) minmax(260px, 1fr); gap: 12px; align-items: start; }
@media (max-width: 900px) { .main { grid-template-columns: 1fr; } }

.board { display: flex; flex-direction: column; gap: 12px; }
.phase {
  background: var(--card); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 12px 14px;
}
.phase.phase-in_progress { border-color: hsl(207 90% 54% / 0.5); }
.phase.phase-done { opacity: 0.7; }
.phase-head { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
.phase-title { font-size: 13px; margin: 0; flex: 1; }
.phase-id { font-family: var(--mono); font-size: 10px; color: var(--muted); }
.phase-summary { color: var(--muted); font-size: 12px; margin: 0 0 8px 0; }

.task-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 2px; }
.task { padding: 6px 8px; border-radius: 6px; }
.task:hover { background: var(--card-2); }
.task.task-active { background: var(--primary-soft); border-left: 2px solid var(--primary); padding-left: 6px; }
.task.task-done { opacity: 0.55; }
.task.task-done .task-title { text-decoration: line-through; }
.task.task-canceled { opacity: 0.4; }
.task.task-canceled .task-title { text-decoration: line-through; }
.task-empty { color: var(--muted); padding: 6px 8px; font-style: italic; }
.task-head { display: flex; align-items: center; gap: 8px; }
.task-id { font-family: var(--mono); font-size: 10px; color: var(--muted); }
.task-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.task-actions { display: flex; align-items: center; gap: 4px; opacity: 0; transition: opacity 150ms; }
.task:hover .task-actions, .task-active .task-actions { opacity: 1; }
.task-desc { color: var(--muted); font-size: 12px; padding-left: 24px; margin-top: 2px; }
.task-outcome { color: var(--accent); font-size: 12px; padding-left: 24px; margin-top: 2px; font-family: var(--mono); }
.task-notes { padding-left: 24px; margin-top: 4px; }
.task-notes summary { color: var(--muted); cursor: pointer; font-size: 11px; }
.task-notes pre { background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 6px 8px; margin: 4px 0 0 0; font-family: var(--mono); font-size: 11px; white-space: pre-wrap; }

.pill { display: inline-block; font-family: var(--mono); font-size: 10px; padding: 2px 7px; border-radius: 999px; text-transform: lowercase; letter-spacing: 0.02em; white-space: nowrap; }
.pill-muted { background: var(--card-2); color: var(--muted); }
.pill-primary { background: var(--primary-soft); color: var(--primary); }
.pill-success { background: var(--accent-soft); color: var(--accent); }
.pill-warning { background: var(--warning-soft); color: var(--warning); }
.pill.strike { text-decoration: line-through; }

.status-menu { background: var(--card-2); color: var(--muted); border: 1px solid var(--border); border-radius: 4px; padding: 2px 4px; font: inherit; font-size: 11px; font-family: var(--mono); }

.btn { background: var(--primary); color: white; border: 0; border-radius: 4px; padding: 6px 12px; font: inherit; font-size: 12px; cursor: pointer; transition: background 120ms; }
.btn:hover { background: hsl(207 90% 60%); }
.btn-sm { padding: 3px 8px; font-size: 11px; }
.btn-ghost { background: transparent; color: var(--muted); border: 1px solid var(--border); }
.btn-ghost:hover { background: var(--card-2); color: var(--fg); }

.add-task, .add-phase, .empty-form { display: flex; gap: 6px; margin-top: 8px; }
.add-phase { margin-top: 0; padding: 8px; background: var(--card); border: 1px dashed var(--border); border-radius: var(--radius); }
.add-task input, .add-phase input, .empty-form input { flex: 1; background: var(--card-2); border: 1px solid var(--border); color: var(--fg); border-radius: 4px; padding: 6px 8px; font: inherit; font-size: 12px; }
.add-task input:focus, .add-phase input:focus, .empty-form input:focus { outline: 0; border-color: var(--primary); }

.changelog { background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 12px; }
.changelog h3 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--muted); margin: 0 0 8px 0; }
.event-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 4px; max-height: 60vh; overflow-y: auto; }
.event { display: grid; grid-template-columns: auto auto 1fr; column-gap: 6px; font-family: var(--mono); font-size: 10px; padding: 4px 6px; border-radius: 4px; color: var(--muted); }
.event-when { color: var(--muted); opacity: 0.7; }
.event-actor { color: var(--primary); text-transform: uppercase; font-size: 9px; align-self: center; }
.event-actor:empty { display: none; }
.event.event-user .event-actor { color: var(--accent); }
.event-kind { color: var(--fg); }
.event-ref, .event-reason { grid-column: 1 / -1; color: var(--muted); padding-left: 16px; }
.event-reason:empty, .event-ref:empty { display: none; }
.event-empty { color: var(--muted); font-style: italic; padding: 6px; }

.empty-state { text-align: center; padding: 32px 16px; background: var(--card); border: 1px dashed var(--border); border-radius: var(--radius); }
.empty-state h3 { font-size: 14px; margin: 0 0 6px 0; }
.empty-state p { color: var(--muted); margin: 0 0 16px 0; }
.empty-state code { font-family: var(--mono); background: var(--card-2); padding: 1px 4px; border-radius: 3px; color: var(--accent); }
.empty-form { max-width: 400px; margin: 0 auto; }
`;
