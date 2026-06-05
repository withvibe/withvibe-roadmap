// SPDX-FileCopyrightText: 2026 WithVibe
// SPDX-License-Identifier: Apache-2.0

import pg from "pg";

const { Pool } = pg;

export const TASK_STATUSES = [
  "pending",
  "in_progress",
  "done",
  "blocked",
  "deferred",
  "canceled",
];
export const PHASE_STATUSES = ["pending", "in_progress", "done"];
export const PLAN_STATUSES = ["planning", "in_progress", "done", "abandoned"];

const SCHEMA = process.env.PGSCHEMA || "public";

// The platform-provided role's search_path is already locked to PGSCHEMA, but
// we set it explicitly so unqualified table names resolve correctly even if a
// driver default leaks through.
export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on("connect", (client) => {
  client.query(`SET search_path TO "${SCHEMA}"`).catch(() => {});
});

// One-shot DDL. Re-runs on every boot are cheap — IF NOT EXISTS makes them
// no-ops once the schema is in place. We use a singleton `plan` row so the
// container's env-scoped schema holds exactly one roadmap.
const DDL = `
CREATE TABLE IF NOT EXISTS plan (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  title TEXT NOT NULL DEFAULT 'Implementation',
  summary TEXT,
  status TEXT NOT NULL DEFAULT 'planning',
  active_task_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS phase (
  id BIGSERIAL PRIMARY KEY,
  position INT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS task (
  id BIGSERIAL PRIMARY KEY,
  phase_id BIGINT NOT NULL REFERENCES phase(id) ON DELETE CASCADE,
  position INT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  notes_md TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  outcome TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS plan_event (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  ref_kind TEXT,
  ref_id BIGINT,
  actor TEXT NOT NULL DEFAULT 'ai',
  reason TEXT,
  payload JSONB,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_phase_position ON phase(position);
CREATE INDEX IF NOT EXISTS idx_task_phase ON task(phase_id, position);
CREATE INDEX IF NOT EXISTS idx_event_at ON plan_event(at DESC);

INSERT INTO plan (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
`;

export async function initSchema() {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL not set — roadmap needs shared-postgres storage"
    );
  }
  await pool.query(DDL);
}

export async function getPlan() {
  const { rows } = await pool.query(
    "SELECT id, title, summary, status, active_task_id, created_at, updated_at FROM plan WHERE id = 1"
  );
  return rows[0] || null;
}

export async function updatePlanMeta({ title, summary, status }) {
  const fields = [];
  const vals = [];
  let i = 1;
  if (title !== undefined) {
    fields.push(`title = $${i++}`);
    vals.push(title);
  }
  if (summary !== undefined) {
    fields.push(`summary = $${i++}`);
    vals.push(summary);
  }
  if (status !== undefined) {
    fields.push(`status = $${i++}`);
    vals.push(status);
  }
  if (fields.length === 0) return;
  fields.push(`updated_at = now()`);
  await pool.query(`UPDATE plan SET ${fields.join(", ")} WHERE id = 1`, vals);
}

export async function setActiveTask(taskId) {
  await pool.query(
    "UPDATE plan SET active_task_id = $1, updated_at = now() WHERE id = 1",
    [taskId]
  );
}

export async function listPhases() {
  const { rows } = await pool.query(
    "SELECT id, position, title, summary, status FROM phase ORDER BY position ASC, id ASC"
  );
  return rows;
}

export async function listTasks() {
  const { rows } = await pool.query(
    "SELECT id, phase_id, position, title, description, notes_md, status, outcome, updated_at FROM task ORDER BY phase_id ASC, position ASC, id ASC"
  );
  return rows;
}

export async function getPhase(id) {
  const { rows } = await pool.query("SELECT * FROM phase WHERE id = $1", [id]);
  return rows[0] || null;
}

export async function getTask(id) {
  const { rows } = await pool.query("SELECT * FROM task WHERE id = $1", [id]);
  return rows[0] || null;
}

export async function nextPhasePosition() {
  const { rows } = await pool.query(
    "SELECT COALESCE(MAX(position), 0) + 1 AS p FROM phase"
  );
  return rows[0].p;
}

export async function nextTaskPosition(phaseId) {
  const { rows } = await pool.query(
    "SELECT COALESCE(MAX(position), 0) + 1 AS p FROM task WHERE phase_id = $1",
    [phaseId]
  );
  return rows[0].p;
}

export async function insertPhase({ title, summary }) {
  const position = await nextPhasePosition();
  const { rows } = await pool.query(
    "INSERT INTO phase (position, title, summary) VALUES ($1, $2, $3) RETURNING *",
    [position, title, summary || null]
  );
  return rows[0];
}

export async function insertTask({ phaseId, title, description }) {
  const position = await nextTaskPosition(phaseId);
  const { rows } = await pool.query(
    "INSERT INTO task (phase_id, position, title, description) VALUES ($1, $2, $3, $4) RETURNING *",
    [phaseId, position, title, description || null]
  );
  return rows[0];
}

export async function updateTaskFields(id, patch) {
  const fields = [];
  const vals = [];
  let i = 1;
  for (const k of [
    "title",
    "description",
    "notes_md",
    "status",
    "outcome",
    "phase_id",
    "position",
  ]) {
    if (patch[k] !== undefined) {
      fields.push(`${k} = $${i++}`);
      vals.push(patch[k]);
    }
  }
  if (fields.length === 0) return getTask(id);
  fields.push("updated_at = now()");
  vals.push(id);
  const { rows } = await pool.query(
    `UPDATE task SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`,
    vals
  );
  return rows[0] || null;
}

export async function updatePhaseFields(id, patch) {
  const fields = [];
  const vals = [];
  let i = 1;
  for (const k of ["title", "summary", "status"]) {
    if (patch[k] !== undefined) {
      fields.push(`${k} = $${i++}`);
      vals.push(patch[k]);
    }
  }
  if (fields.length === 0) return getPhase(id);
  fields.push("updated_at = now()");
  vals.push(id);
  const { rows } = await pool.query(
    `UPDATE phase SET ${fields.join(", ")} WHERE id = $${i} RETURNING *`,
    vals
  );
  return rows[0] || null;
}

export async function deletePhase(id) {
  await pool.query("DELETE FROM phase WHERE id = $1", [id]);
}

export async function deleteTask(id) {
  await pool.query("DELETE FROM task WHERE id = $1", [id]);
}

export async function clearPlan() {
  await pool.query("DELETE FROM phase");
  await pool.query(
    "UPDATE plan SET active_task_id = NULL, status = 'planning', updated_at = now() WHERE id = 1"
  );
}

export async function logEvent({
  kind,
  refKind = null,
  refId = null,
  actor = "ai",
  reason = null,
  payload = null,
}) {
  await pool.query(
    "INSERT INTO plan_event (kind, ref_kind, ref_id, actor, reason, payload) VALUES ($1, $2, $3, $4, $5, $6)",
    [kind, refKind, refId, actor, reason, payload ? JSON.stringify(payload) : null]
  );
}

// Single-number freshness stamp used by the UI to decide whether to refetch.
// The greatest updated_at across every mutable row, in ms since epoch. Cheap
// (4 indexed MAX queries, no scan) and stable: any tool call that changes
// state also bumps updated_at on at least one row.
export async function getVersion() {
  const { rows } = await pool.query(`
    SELECT GREATEST(
      COALESCE((SELECT MAX(updated_at) FROM plan), 'epoch'::timestamptz),
      COALESCE((SELECT MAX(updated_at) FROM phase), 'epoch'::timestamptz),
      COALESCE((SELECT MAX(updated_at) FROM task), 'epoch'::timestamptz),
      COALESCE((SELECT MAX(at) FROM plan_event), 'epoch'::timestamptz)
    ) AS v
  `);
  const v = rows[0]?.v;
  return v ? new Date(v).getTime() : 0;
}

export async function listEvents(limit = 50) {
  const { rows } = await pool.query(
    "SELECT id, kind, ref_kind, ref_id, actor, reason, payload, at FROM plan_event ORDER BY at DESC, id DESC LIMIT $1",
    [limit]
  );
  return rows;
}

// Returns the full plan shape used by both the UI and the AI's get_plan tool.
export async function getFullPlan({ eventLimit = 20 } = {}) {
  const [plan, phases, tasks, events] = await Promise.all([
    getPlan(),
    listPhases(),
    listTasks(),
    listEvents(eventLimit),
  ]);
  const tasksByPhase = new Map();
  for (const t of tasks) {
    if (!tasksByPhase.has(t.phase_id)) tasksByPhase.set(t.phase_id, []);
    tasksByPhase.get(t.phase_id).push(t);
  }
  const activeTask = plan?.active_task_id
    ? tasks.find((t) => String(t.id) === String(plan.active_task_id)) || null
    : null;
  const activePhase = activeTask
    ? phases.find((p) => String(p.id) === String(activeTask.phase_id)) || null
    : null;
  const totalTasks = tasks.length;
  const doneTasks = tasks.filter((t) => t.status === "done").length;
  return {
    plan,
    phases: phases.map((p) => ({
      ...p,
      tasks: tasksByPhase.get(p.id) || [],
    })),
    events,
    active: { task: activeTask, phase: activePhase },
    progress: { done: doneTasks, total: totalTasks },
  };
}
