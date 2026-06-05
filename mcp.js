// SPDX-FileCopyrightText: 2026 WithVibe
// SPDX-License-Identifier: Apache-2.0

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  PHASE_STATUSES,
  TASK_STATUSES,
  PLAN_STATUSES,
  clearPlan,
  deletePhase,
  deleteTask,
  getFullPlan,
  getPhase,
  getTask,
  insertPhase,
  insertTask,
  logEvent,
  setActiveTask,
  updatePhaseFields,
  updatePlanMeta,
  updateTaskFields,
} from "./db.js";

// Compact, model-friendly summary of the whole plan. Returned in the tail of
// every mutation so the AI never holds stale state.
function renderPlanText(plan) {
  const out = [];
  const title = plan.plan?.title || "Implementation";
  const status = plan.plan?.status || "planning";
  const { done, total } = plan.progress;
  out.push(`# ${title}  [plan: ${status}]   progress: ${done}/${total}`);
  if (plan.plan?.summary) out.push(`  ${plan.plan.summary}`);

  if (plan.active.task) {
    const t = plan.active.task;
    const p = plan.active.phase;
    out.push("");
    out.push(
      `>> ACTIVE: ${p ? `Phase #${p.id} "${p.title}" / ` : ""}Task #${t.id} "${t.title}"`
    );
  } else {
    out.push("");
    out.push(">> ACTIVE: (none — set one with set_active_task)");
  }

  out.push("");
  if (plan.phases.length === 0) {
    out.push("(no phases yet — call propose_plan or add_phase)");
  }
  for (const ph of plan.phases) {
    const ic =
      ph.status === "done" ? "[x]" : ph.status === "in_progress" ? "[~]" : "[ ]";
    out.push(`${ic} Phase #${ph.id}  ${ph.title}   (${ph.status})`);
    if (ph.summary) out.push(`     ${ph.summary}`);
    for (const t of ph.tasks) {
      const tic =
        t.status === "done"
          ? "[x]"
          : t.status === "in_progress"
            ? "[~]"
            : t.status === "blocked"
              ? "[!]"
              : t.status === "deferred"
                ? "[>]"
                : t.status === "canceled"
                  ? "[/]"
                  : "[ ]";
      out.push(`   ${tic} Task #${t.id}  ${t.title}   (${t.status})`);
      if (t.outcome) out.push(`       outcome: ${t.outcome}`);
    }
  }

  if (plan.events.length > 0) {
    out.push("");
    out.push("— Recent plan changes —");
    for (const e of plan.events.slice(0, 8)) {
      const when = new Date(e.at).toISOString().slice(0, 16).replace("T", " ");
      const ref = e.ref_kind ? `${e.ref_kind}#${e.ref_id}` : "";
      const reason = e.reason ? `  — ${e.reason}` : "";
      out.push(`${when}  [${e.actor}] ${e.kind} ${ref}${reason}`);
    }
  }

  return out.join("\n");
}

async function tail() {
  const plan = await getFullPlan();
  return renderPlanText(plan);
}

function actorFromHeaders(req) {
  // MCP requests come through the platform bridge which sets x-withvibe-user-id
  // when a real user is on the other end. The orchestrator AI uses the same
  // bridge but on behalf of a user, so we default to "ai" and let UI mutations
  // tag themselves as "user".
  return req?.headers?.["x-withvibe-actor"] === "user" ? "user" : "ai";
}

export function registerTools(server, req) {
  const actor = actorFromHeaders(req);

  server.registerTool(
    "get_plan",
    {
      description:
        "Return the full implementation roadmap: phases, tasks, statuses, active focus, recent changes. Call this first when you start working in a session so you know what's done and where we are.",
      inputSchema: {},
    },
    async () => ({ content: [{ type: "text", text: await tail() }] })
  );

  server.registerTool(
    "propose_plan",
    {
      description:
        "Replace the entire roadmap with a new structure. Use at the start of a feature (after agreeing with the user on the approach) or after a major re-plan. Pass `reason` so the change log records why.",
      inputSchema: {
        title: z.string().min(1).describe("Feature/roadmap title"),
        summary: z
          .string()
          .optional()
          .describe("One-paragraph summary of what we're building"),
        reason: z
          .string()
          .optional()
          .describe(
            "Why this plan / why it's replacing the previous one (recorded in plan change log)"
          ),
        phases: z
          .array(
            z.object({
              title: z.string().min(1),
              summary: z.string().optional(),
              tasks: z
                .array(
                  z.object({
                    title: z.string().min(1),
                    description: z.string().optional(),
                  })
                )
                .default([]),
            })
          )
          .min(1),
      },
    },
    async ({ title, summary, reason, phases }) => {
      await clearPlan();
      await updatePlanMeta({ title, summary, status: "in_progress" });
      const created = [];
      for (const ph of phases) {
        const phase = await insertPhase({ title: ph.title, summary: ph.summary });
        const taskIds = [];
        for (const t of ph.tasks) {
          const task = await insertTask({
            phaseId: phase.id,
            title: t.title,
            description: t.description,
          });
          taskIds.push(task.id);
        }
        created.push({ phaseId: phase.id, taskIds });
      }
      await logEvent({
        kind: "plan_proposed",
        actor,
        reason: reason || "initial plan",
        payload: { title, phaseCount: phases.length },
      });
      return {
        content: [
          {
            type: "text",
            text: `Roadmap set: "${title}" with ${phases.length} phase(s).\n\n${await tail()}`,
          },
        ],
      };
    }
  );

  server.registerTool(
    "add_phase",
    {
      description:
        "Append a new phase to the roadmap (mid-flight scope expansion). Pass `reason` so the change log explains why.",
      inputSchema: {
        title: z.string().min(1),
        summary: z.string().optional(),
        reason: z.string().optional(),
      },
    },
    async ({ title, summary, reason }) => {
      const ph = await insertPhase({ title, summary });
      await logEvent({
        kind: "phase_added",
        refKind: "phase",
        refId: ph.id,
        actor,
        reason: reason || null,
        payload: { title },
      });
      return {
        content: [
          {
            type: "text",
            text: `Added phase #${ph.id}: ${title}\n\n${await tail()}`,
          },
        ],
      };
    }
  );

  server.registerTool(
    "add_task",
    {
      description:
        "Append a task to an existing phase. Use when you discover work that wasn't in the original plan. Pass `reason` if it's a scope expansion.",
      inputSchema: {
        phase_id: z.number().int().positive(),
        title: z.string().min(1).describe("Short, imperative phrasing"),
        description: z.string().optional(),
        reason: z.string().optional(),
      },
    },
    async ({ phase_id, title, description, reason }) => {
      const phase = await getPhase(phase_id);
      if (!phase)
        return {
          content: [{ type: "text", text: `No phase #${phase_id}` }],
          isError: true,
        };
      const task = await insertTask({ phaseId: phase_id, title, description });
      await logEvent({
        kind: "task_added",
        refKind: "task",
        refId: task.id,
        actor,
        reason: reason || null,
        payload: { title, phase_id },
      });
      return {
        content: [
          {
            type: "text",
            text: `Added task #${task.id} to phase #${phase_id}: ${title}\n\n${await tail()}`,
          },
        ],
      };
    }
  );

  server.registerTool(
    "set_active_task",
    {
      description:
        "Mark a task as the one currently in progress (the 'you are here' marker). Call this BEFORE starting work on a task. Automatically flips the task's status to in_progress and its phase to in_progress if not already.",
      inputSchema: {
        task_id: z.number().int().positive(),
      },
    },
    async ({ task_id }) => {
      const task = await getTask(task_id);
      if (!task)
        return {
          content: [{ type: "text", text: `No task #${task_id}` }],
          isError: true,
        };
      await updateTaskFields(task_id, { status: "in_progress" });
      await updatePhaseFields(task.phase_id, { status: "in_progress" });
      await setActiveTask(task_id);
      await logEvent({
        kind: "active_set",
        refKind: "task",
        refId: task_id,
        actor,
      });
      return {
        content: [
          {
            type: "text",
            text: `Now active: task #${task_id} "${task.title}".\n\n${await tail()}`,
          },
        ],
      };
    }
  );

  server.registerTool(
    "complete_task",
    {
      description:
        "Mark a task done. Pass a 1-line `outcome` describing what shipped / how you verified it. If this was the active task, also pass the next task to make active (or call set_active_task separately).",
      inputSchema: {
        task_id: z.number().int().positive(),
        outcome: z
          .string()
          .optional()
          .describe(
            "1-line summary of what was actually done. Keeps the trail readable for future sessions."
          ),
      },
    },
    async ({ task_id, outcome }) => {
      const task = await getTask(task_id);
      if (!task)
        return {
          content: [{ type: "text", text: `No task #${task_id}` }],
          isError: true,
        };
      await updateTaskFields(task_id, {
        status: "done",
        outcome: outcome || null,
      });
      // Auto-clear active marker if it was this task.
      const plan = await getFullPlan();
      if (
        plan.plan?.active_task_id &&
        String(plan.plan.active_task_id) === String(task_id)
      ) {
        await setActiveTask(null);
      }
      // Auto-close the phase if every task is done.
      const phaseTasks = plan.phases.find((p) => p.id === task.phase_id)?.tasks ||
        [];
      const allDone = phaseTasks.every(
        (t) => String(t.id) === String(task_id) || t.status === "done"
      );
      if (allDone && phaseTasks.length > 0) {
        await updatePhaseFields(task.phase_id, { status: "done" });
        await logEvent({
          kind: "phase_done",
          refKind: "phase",
          refId: task.phase_id,
          actor,
        });
      }
      await logEvent({
        kind: "task_done",
        refKind: "task",
        refId: task_id,
        actor,
        reason: outcome || null,
      });
      return {
        content: [
          {
            type: "text",
            text: `Completed task #${task_id}.\n\n${await tail()}`,
          },
        ],
      };
    }
  );

  server.registerTool(
    "update_task",
    {
      description:
        "Edit a task's title, description, or status. For status changes other than done (use complete_task) — e.g. blocked, deferred, canceled — pass `reason` so the change log explains why.",
      inputSchema: {
        task_id: z.number().int().positive(),
        title: z.string().min(1).optional(),
        description: z.string().optional(),
        status: z.enum(TASK_STATUSES).optional(),
        reason: z.string().optional(),
      },
    },
    async ({ task_id, title, description, status, reason }) => {
      const task = await getTask(task_id);
      if (!task)
        return {
          content: [{ type: "text", text: `No task #${task_id}` }],
          isError: true,
        };
      const patch = {};
      if (title !== undefined) patch.title = title;
      if (description !== undefined) patch.description = description;
      if (status !== undefined) patch.status = status;
      const updated = await updateTaskFields(task_id, patch);
      await logEvent({
        kind:
          status && status !== task.status ? "task_status_changed" : "task_edited",
        refKind: "task",
        refId: task_id,
        actor,
        reason: reason || null,
        payload: status ? { from: task.status, to: status } : null,
      });
      return {
        content: [
          {
            type: "text",
            text: `Updated task #${task_id}.\n\n${await tail()}`,
          },
        ],
      };
    }
  );

  server.registerTool(
    "update_phase",
    {
      description:
        "Edit a phase's title, summary, or status. Use to mark a whole phase blocked/abandoned with a reason.",
      inputSchema: {
        phase_id: z.number().int().positive(),
        title: z.string().min(1).optional(),
        summary: z.string().optional(),
        status: z.enum(PHASE_STATUSES).optional(),
        reason: z.string().optional(),
      },
    },
    async ({ phase_id, title, summary, status, reason }) => {
      const phase = await getPhase(phase_id);
      if (!phase)
        return {
          content: [{ type: "text", text: `No phase #${phase_id}` }],
          isError: true,
        };
      const patch = {};
      if (title !== undefined) patch.title = title;
      if (summary !== undefined) patch.summary = summary;
      if (status !== undefined) patch.status = status;
      await updatePhaseFields(phase_id, patch);
      await logEvent({
        kind:
          status && status !== phase.status
            ? "phase_status_changed"
            : "phase_edited",
        refKind: "phase",
        refId: phase_id,
        actor,
        reason: reason || null,
        payload: status ? { from: phase.status, to: status } : null,
      });
      return {
        content: [
          { type: "text", text: `Updated phase #${phase_id}.\n\n${await tail()}` },
        ],
      };
    }
  );

  server.registerTool(
    "add_note",
    {
      description:
        "Append a markdown note to a task — decisions made, things tried that didn't work, references. This is what makes the trail useful when you come back later.",
      inputSchema: {
        task_id: z.number().int().positive(),
        note: z.string().min(1),
      },
    },
    async ({ task_id, note }) => {
      const task = await getTask(task_id);
      if (!task)
        return {
          content: [{ type: "text", text: `No task #${task_id}` }],
          isError: true,
        };
      const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
      const appended =
        (task.notes_md ? task.notes_md + "\n\n" : "") +
        `> ${stamp} (${actor})\n${note}`;
      await updateTaskFields(task_id, { notes_md: appended });
      await logEvent({
        kind: "note_added",
        refKind: "task",
        refId: task_id,
        actor,
      });
      return {
        content: [
          { type: "text", text: `Noted on task #${task_id}.\n\n${await tail()}` },
        ],
      };
    }
  );

  server.registerTool(
    "log_change",
    {
      description:
        "Record an explicit plan-change entry without mutating data. Use to narrate decisions visible only at the planning level (e.g. 'switched strategy from REST to GraphQL because…'). For state changes that come with mutations, the other tools already write events automatically.",
      inputSchema: {
        reason: z.string().min(1),
        ref_kind: z.enum(["plan", "phase", "task"]).optional(),
        ref_id: z.number().int().positive().optional(),
      },
    },
    async ({ reason, ref_kind, ref_id }) => {
      await logEvent({
        kind: "note",
        refKind: ref_kind || "plan",
        refId: ref_id || null,
        actor,
        reason,
      });
      return {
        content: [{ type: "text", text: `Logged: ${reason}\n\n${await tail()}` }],
      };
    }
  );
}

export function newMcpServer() {
  return new McpServer(
    { name: "roadmap", version: "2.0.0" },
    { capabilities: { tools: {} } }
  );
}
