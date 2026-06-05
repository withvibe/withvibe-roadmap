# WithVibe Roadmap Plugin

> A per-env implementation roadmap board for [WithVibe](https://withvibe.dev) — Postgres-backed, with an MCP server the AI orchestrator drives directly.

Multi-phase features drift. Plans change mid-flight. After a few sessions you lose track of what shipped, what's pending, and which step you're actually on. This plugin gives the AI a structured place to keep that state — and the user a live view of it.

```
Feature: Auth rewrite                          ▓▓▓▓░░░░░░ 4/11 tasks
you are here →  API layer  ›  Wire DTO validation

[x] Phase 1: Schema (done)
[~] Phase 2: API layer (in progress)
    [x] Endpoint scaffolding
    [x] Auth guard
    [~] Wire DTO validation     ← active
    [ ] Error envelope
[ ] Phase 3: Web
[ ] Phase 4: QA

— Plan changes —
2026-05-28  AI added Phase 4 (QA) — reason: integration tests not in original scope
2026-05-29  user removed "Add caching" — reason: deferred to follow-up
```

## What's in the box

- **Hierarchical roadmap** — feature → phase → task, with `pending / in_progress / done / blocked / deferred / canceled` statuses.
- **"You are here" marker** — exactly one task is active at a time; the banner is the recovery anchor when you context-switch back.
- **Plan-change log** — every add/remove/rename/status-change records an actor (`ai` or `user`) and an optional reason. The trail makes drift visible.
- **MCP tools** the AI orchestrator uses without prompting: `propose_plan`, `set_active_task`, `complete_task`, `add_note`, `update_task`, `log_change`, …
- **Live UI** — htmx-based, polls a tiny version endpoint so the iframe updates within ~4s of any AI change without scroll jumps.
- **Persistent** — uses WithVibe's `shared-postgres` plugin storage, so state survives container restarts.

## Architecture

```
manifest.yaml ──→ WithVibe spawns one container per env
       ↓
   server.js (express)
   ├── /health         platform health probe
   ├── /mcp            AI orchestrator's MCP endpoint  ─→ mcp.js
   ├── /ui             dark-themed htmx UI             ─→ ui.js
   └── /ui/version     cheap freshness check (drives live updates)
                ↓
              db.js (pg)
                ↓
          shared-postgres
          per-env schema
          plan / phase / task / plan_event
```

- **Scope: `env`** — one container per (env, plugin). Each env gets its own roadmap, its own Postgres schema, its own port.
- **Storage**: `shared-postgres` — the platform provisions a dedicated role + schema in the `withvibe_plugins` database and injects `DATABASE_URL` + `PGSCHEMA` at spawn. The plugin role can't reach the main `withvibe` DB.
- **State surface**: four tables in [db.js](db.js) — `plan` (singleton), `phase`, `task`, `plan_event` (change log).

## MCP tools

All tools return the full updated plan in the trailing text so the AI never holds stale state.

| Tool | Purpose |
|---|---|
| `get_plan` | Read the full roadmap + active marker + last 20 events. |
| `propose_plan` | Replace the whole roadmap (initial planning or a major re-plan). |
| `add_phase` / `add_task` | Append work mid-flight; `reason` recorded. |
| `set_active_task` | Mark the "you are here" anchor before starting work. |
| `complete_task` | Mark done with a 1-line outcome; auto-closes the phase if every task is done. |
| `update_task` / `update_phase` | Edit title/description/status (blocked, deferred, canceled) with reason. |
| `add_note` | Append a markdown note — decisions, things tried, references. |
| `log_change` | Narrate a plan-level decision without mutating data. |

See [mcp.js](mcp.js) for the full schemas.

## Build

```bash
docker build -t local/roadmap:2.0 .
```

The image is multi-arch-friendly via Node 20 Alpine, ~150 MB, no native build steps.

## Install in WithVibe

1. Workspace admin → **Plugins** → **Install plugin**.
2. Paste the contents of [manifest.yaml](manifest.yaml) into the editor.
3. The platform pulls / locates the image and registers the plugin.
4. Open any env → the **Roadmap** tab appears in the plugin panel.

To update after rebuilding the image, hit **Update** on the plugin row in the admin list — running instances are stopped so the next env start picks up the new image.

## Manifest

The manifest is the entire install input. The fields that matter for this plugin:

```yaml
id: withvibe.roadmap          # URL + tool prefix; reverse-DNS-ish
name: Roadmap                 # display name in the env's plugin panel
version: 2.0.0
icon: list-todo               # Lucide icon
image: local/roadmap:2.0    # OCI ref

scope: env                    # one container per env
storage:
  kind: shared-postgres       # platform-managed Postgres role + schema

ui:
  path: /ui                   # iframe entry point
  websocket: false

mcp:
  enabled: true
  path: /mcp                  # MCP endpoint the AI auto-discovers
```

## Local development

```bash
# Build
docker build -t local/roadmap:2.0 .

# Run standalone (requires a Postgres reachable via DATABASE_URL)
docker run --rm -p 8080:8080 \
  -e DATABASE_URL="postgres://user:pass@host.docker.internal:5432/withvibe_plugins" \
  -e PGSCHEMA="roadmap_dev" \
  local/roadmap:2.0

# Then open http://localhost:8080/ui
```

When developing against a real WithVibe install, hit **Update** in the admin Plugins page after each rebuild — that stops running instances so the next env start picks up the new image.

## Repository layout

```
manifest.yaml   WithVibe plugin manifest
Dockerfile      builds the runtime image
package.json    npm deps (express, pg, @modelcontextprotocol/sdk, zod)
server.js       express entry, HTTP + MCP routes
db.js           pg pool, schema init, query helpers
mcp.js          MCP tool registrations
ui.js           htmx UI rendering + dark-themed CSS
```

## Contributing

Issues and PRs welcome. Keep changes focused and document the *why* in commits.

## License

[Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for attribution.
