// SPDX-FileCopyrightText: 2026 WithVibe
// SPDX-License-Identifier: Apache-2.0

import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  deletePhase,
  deleteTask,
  getFullPlan,
  getTask,
  getVersion,
  initSchema,
  insertPhase,
  insertTask,
  logEvent,
  setActiveTask,
  updatePhaseFields,
  updatePlanMeta,
  updateTaskFields,
} from "./db.js";
import { newMcpServer, registerTools } from "./mcp.js";
import { renderApp, renderShell } from "./ui.js";

await initSchema();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ── health ────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ ok: true }));

// ── MCP ───────────────────────────────────────────────────────────────────
// One transport per request — stateless. The platform forwards the runner's
// JSON-RPC body verbatim and sets x-withvibe-* headers we can use to attribute
// the actor (we pass the request into registerTools for that).
app.all("/mcp", async (req, res) => {
  const server = newMcpServer();
  registerTools(server, req);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: err instanceof Error ? err.message : "Internal error",
        },
        id: null,
      });
    }
  }
});

// ── UI ────────────────────────────────────────────────────────────────────
// Mutations re-render the whole #app body so the change log and progress bar
// stay in sync with whatever just changed. The shell polls /ui/app every few
// seconds so MCP-driven changes (made by the AI in chat) show up without a
// manual refresh.
//
// URL-relative paths in hx-post values (e.g. "ui/task/.../active") matter:
// the WithVibe proxy mounts this plugin behind /api/plugins/view/<id>/env/<envId>/,
// and absolute paths would escape the mount.

app.get("/ui", async (_req, res) => {
  res.send(renderShell(await renderApp()));
});

app.get("/ui/app", async (_req, res) => {
  res.send(await renderApp());
});

// Tiny endpoint the iframe hits to decide whether a re-render is necessary.
// Returning just an integer means the client can compare against its last
// seen value without parsing anything. Avoids the scroll-jump that came
// from blindly swapping innerHTML every 4s.
app.get("/ui/version", async (_req, res) => {
  const version = await getVersion();
  res.json({ version });
});

// All UI mutations attribute the actor as "user" so the change log reflects
// who did what. Reuses the same DB helpers as MCP so behavior stays aligned.
const USER = "user";

app.post("/ui/phase", async (req, res) => {
  const title = String(req.body?.title || "").trim();
  if (title) {
    const ph = await insertPhase({ title });
    await logEvent({
      kind: "phase_added",
      refKind: "phase",
      refId: ph.id,
      actor: USER,
      payload: { title },
    });
  }
  res.send(await renderApp());
});

app.post("/ui/phase/:id/task", async (req, res) => {
  const phaseId = Number(req.params.id);
  const title = String(req.body?.title || "").trim();
  if (title && Number.isFinite(phaseId)) {
    const t = await insertTask({ phaseId, title });
    await logEvent({
      kind: "task_added",
      refKind: "task",
      refId: t.id,
      actor: USER,
      payload: { title, phase_id: phaseId },
    });
  }
  res.send(await renderApp());
});

app.post("/ui/phase/:id/delete", async (req, res) => {
  const id = Number(req.params.id);
  if (Number.isFinite(id)) {
    await deletePhase(id);
    await logEvent({
      kind: "phase_removed",
      refKind: "phase",
      refId: id,
      actor: USER,
    });
  }
  res.send(await renderApp());
});

app.post("/ui/task/:id/active", async (req, res) => {
  const id = Number(req.params.id);
  const task = await getTask(id);
  if (task) {
    await updateTaskFields(id, { status: "in_progress" });
    await updatePhaseFields(task.phase_id, { status: "in_progress" });
    await setActiveTask(id);
    await logEvent({
      kind: "active_set",
      refKind: "task",
      refId: id,
      actor: USER,
    });
  }
  res.send(await renderApp());
});

app.post("/ui/task/:id/complete", async (req, res) => {
  const id = Number(req.params.id);
  const task = await getTask(id);
  if (task) {
    await updateTaskFields(id, { status: "done" });
    const plan = await getFullPlan();
    if (
      plan.plan?.active_task_id &&
      String(plan.plan.active_task_id) === String(id)
    ) {
      await setActiveTask(null);
    }
    const phaseTasks =
      plan.phases.find((p) => p.id === task.phase_id)?.tasks || [];
    const allDone = phaseTasks.every(
      (t) => String(t.id) === String(id) || t.status === "done"
    );
    if (allDone && phaseTasks.length > 0) {
      await updatePhaseFields(task.phase_id, { status: "done" });
    }
    await logEvent({
      kind: "task_done",
      refKind: "task",
      refId: id,
      actor: USER,
    });
  }
  res.send(await renderApp());
});

app.post("/ui/task/:id/status", async (req, res) => {
  const id = Number(req.params.id);
  const status = String(req.body?.status || "").trim();
  const task = await getTask(id);
  if (task && status) {
    await updateTaskFields(id, { status });
    await logEvent({
      kind: "task_status_changed",
      refKind: "task",
      refId: id,
      actor: USER,
      payload: { from: task.status, to: status },
    });
  }
  res.send(await renderApp());
});

app.post("/ui/task/:id/delete", async (req, res) => {
  const id = Number(req.params.id);
  if (Number.isFinite(id)) {
    await deleteTask(id);
    await logEvent({
      kind: "task_removed",
      refKind: "task",
      refId: id,
      actor: USER,
    });
  }
  res.send(await renderApp());
});

app.post("/ui/plan/title", async (req, res) => {
  const title = String(req.body?.title || "").trim();
  if (title) {
    await updatePlanMeta({ title });
    await logEvent({ kind: "plan_renamed", actor: USER, payload: { title } });
  }
  res.send(await renderApp());
});

// Bare-root convenience — a stray GET / inside the container lands somewhere
// useful instead of 404ing.
app.get("/", (_req, res) => res.redirect("/ui"));

const PORT = Number(process.env.PORT) || 8080;
app.listen(PORT, () => {
  console.log(`roadmap plugin listening on :${PORT}`);
  console.log(`  MCP endpoint: POST /mcp`);
  console.log(`  UI:           GET  /ui`);
  console.log(`  schema:       ${process.env.PGSCHEMA || "(none)"}`);
});
