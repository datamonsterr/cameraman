# AGENTS.md — Contributor & agent guide

This repo is built with a **subagent-driven, spec-first, test-first** workflow. Read this
before making changes. It applies to human and AI contributors alike.

## Golden rules

1. **Spec is law.** `SPEC.md` defines scope. Build to the FR acceptance criteria — no more,
   no less. If the spec is wrong, change the spec (and note it) before the code.
2. **TDD.** Red → green → refactor. Write the failing test at an agreed seam first, then the
   minimum code to pass. No feature merges without tests for its FR.
3. **Record decisions.** Settled terminology and decisions go in `CONTEXT.md`; architectural
   decisions get an ADR in `docs/adr/`.
4. **Check current docs** before coding against any library/SDK/CLI. No API from memory.
5. **Small, reviewable commits**, Conventional Commits style (`feat:`, `fix:`, `test:`,
   `docs:`, `chore:`, `refactor:`). Prose (commits/PRs/docs) is normal English.

## Orchestration workflow

The main session acts as **controller**: plan → brief → dispatch → review → decide. It does
not hand-edit source for delegated tasks. Implementation is delegated:

- **Primary:** `superorchestrator` MCP — route/spawn/wait/review across harnesses & accounts.
- **Fallback (when superorchestrator is unavailable):** native subagents — a capable model
  (`claude-sonnet-5-5`) for judgment/integration tasks, a cheap model (`claude-haiku-5-5`)
  for mechanical 1–2 file tasks, medium effort.

Per task: dispatch implementer → **spec-compliance review** → **code-quality review** →
mark complete. Never skip a review; never start quality review before spec review passes.
(See the `subagent-driven-development` skill.)

## Monorepo layout

```
backend/   Rust (Axum) API + WebSocket, auth, persistence, discovery, workflow supervision
worker/    Python detection worker: RTSP, YOLO, code-block sandbox, landmark calibration
web/       React + Vite + shadcn/ui web app (full management)
mobile/    Expo (React Native) monitor-only app
db/        SQL migrations + seed data
infra/     Dockerfiles, docker-compose, deploy config
docs/       SPEC, ADRs, API docs, design notes
scripts/    dev & ops scripts
.github/    CI/CD workflows
```

## Local development

```bash
docker compose up        # full stack (postgres, redis, backend, worker, web)
```

Per-service dev commands live in each service's README. Env vars are documented in
`.env.example`; never commit real secrets.

## Definition of Done

See `SPEC.md` §12. A change is not done until its FR tests pass in CI.

## CI/CD Resource & Push Policy
This account shares 40 concurrent GitHub Actions slots across all repos and a 3,000 min/month private-repo budget. Treat CI as a final verification gate, NOT a scratchpad.

1. **Verify locally before pushing:** Run the repo's local check task (`mise run check`, `cargo clippy`, `pnpm lint && pnpm typecheck && pnpm test`) and confirm it passes before `git push`.
2. **Batch commits:** Do not push after every small edit. Commit locally and push only when a logical milestone passes local checks.
3. **Draft PRs first:** Always open new PRs as `--draft` (`gh pr create --draft`). Only mark ready (`gh pr ready`) once local checks pass and implementation is complete.
4. **No unnecessary heavy triggers:** Do not add `e2e` or `bench` labels unless explicitly requested.
5. **Workflow hygiene:** Every new GitHub Actions workflow MUST include `concurrency` (`cancel-in-progress: true`), `timeout-minutes` on every job, and path filters. Never add `macos-*` or `windows-*` jobs to private PR triggers.
