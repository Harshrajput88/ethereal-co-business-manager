# Ethereal Co. — Agent Instructions

Concise operating rules for AI coding agents in this repository. Project
documentation is authoritative over this file; do not duplicate business
requirements here.

## Project context

Ethereal Co. Business Manager is a React + Vite dashboard for a bottled-water
business, used by an **owner** and approved **salespeople**. Supabase provides
authentication and the (planned) database backend. The app is early-stage: login,
registration, owner approval workflow, and a dashboard shell work; most business
features are placeholders.

Read only what the task needs:

- `README.md` — stack and current implementation status
- `docs/PHASE_1_DATABASE_ARCHITECTURE.md` — schema and data model
- `docs/PHASE_1_PERMISSION_MATRIX.md` — roles, RLS, access rules
- `docs/PHASE_1_WORKFLOWS.md` and `docs/PHASE_1_IMPLEMENTATION_PLAN.md` — flows and sequencing
- `docs/ETHEREAL_TARGET_ARCHITECTURE.md` — target architecture

## Technology stack

- React 19, JSX, ES modules — **no TypeScript**
- Vite 8 for dev/build
- Supabase JS client (`src/lib/supabase.js`) for auth and data
- Plain CSS in `src/App.css` (components) and `src/index.css` (globals)
- Oxlint for linting; no router, state library, or test suite

## Coding conventions

- JavaScript/JSX only; match existing file style (2-space indent, single quotes, no semicolons in existing files).
- Keep UI logic consistent with the current `App.jsx` structure unless a task explicitly calls for refactoring.
- Prefer small, focused components over extending `App.jsx` further when adding features.
- Reuse existing CSS classes and tokens before introducing new styles; keep styles in the existing CSS files.
- No new dependencies without stating why an existing tool cannot do the job.
- Never edit `src/App-backup.jsx`; it is a byte-identical backup.

## Security requirements

- Never read, print, copy, or modify `.env`, `.env.local`, `.env.staging.local`, or any credential file.
- Only Vite public keys (`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` /
  `VITE_SUPABASE_PUBLISHABLE_KEY`) may reach the client. A `service_role` or
  secret key must never appear in client code, logs, or committed files.
- Treat the browser as untrusted: enforce authorization in database RLS policies,
  never only in UI conditionals.
- Do not connect to staging or production databases, run migrations, or run SQL
  against remote projects without explicit instruction.
- Do not add scripts that execute untrusted input or shell out with user data.
- Report suspected credential exposure immediately; do not attempt to "fix" it by
  rewriting history or rotating keys yourself.

## Git safety rules

- Do not commit, push, amend, rebase, reset, or force operations unless explicitly asked.
- Do not discard or overwrite existing uncommitted work; inspect `git status` and diffs before editing.
- Stage specific paths only; never `git add -A` on a dirty tree.
- Leave `supabase/` configuration and migrations untouched unless the task is specifically about them.

## Token efficiency rules

- Prefer targeted `grep`/`glob` over reading whole files or directories.
- Do not re-read files already inspected in the session; do not repeat the same
  directory listings or status updates.
- Reuse the docs listed above instead of restating business context.
- Keep responses and status summaries short; no redundant restatement of plans.
- One agent per task; do not spawn parallel agents for the same work.
- Keep configuration and instruction files concise.

## Skill usage

Installed project skills live in `.agents/skills/` (see `docs/OPENCODE_SKILLS_INVENTORY.md`):

| Skill | Use for |
| --- | --- |
| `frontend-design` | New or reshaped visual UI, layout, typography, palette |
| `designing-user-experience` | Flows, forms, validation, empty/loading/error states, destructive actions |
| `webapp-testing` | Browser-verified workflow testing (Playwright 1.65.2 + Chromium 1255 installed; see `docs/OPENCODE_TOOLING_VERIFICATION.md`) |
| `vercel-react-best-practices` | React performance and data-fetching review |

- Load the **minimum** set: usually one skill per task. Do not combine
  `frontend-design` and `designing-user-experience` for routine coding.
- Do not load testing skills for documentation or config tasks.
- For `vercel-react-best-practices`, open only `SKILL.md` plus the specific rule
  file needed — not the 108 KB `AGENTS.md` or all `rules/` files.
- This app is a Vite SPA: apply the Next.js/RSC rules (server actions, `next/dynamic`,
  Suspense streaming) only when genuinely relevant; prefer the client-side,
  re-render, rendering and JS categories.

## Working method

1. **Inspect before editing.** Read the relevant files, confirm current behavior, and check for existing work that already covers the request.
2. Make the smallest change that satisfies the task; preserve surrounding style.
3. **Verify before claiming success.** Run `npm run lint` and `npm run build` for
   source changes. There is no automated test suite — do not claim tests passed.
   If a claim is unverified, say so explicitly.
4. Report what changed, what was verified, and what remains unverified. Do not
   begin unrelated features or continue into new phases without instruction.
