# OpenCode Tooling Verification — Ethereal Co.

Verification of the project instruction file, the four installed Agent Skills, the
skills lockfile, and the Playwright browser-testing runtime.

- **Date:** 17 November 2026
- **Project:** `C:\Users\harsh\Desktop\ethereal-business-manager\ethereal-co`
- **Branch:** `main`
- **OpenCode:** v2.3.0 · **Node:** v26.13.0 · **Python:** 3.13.6 (CPython, Program Files)
- **Scope:** developer tooling only. No application source, Supabase config, database,
  environment file, skill, or commit was changed.

## Status summary

| Area | Result |
| --- | --- |
| `AGENTS.md` | Present and compliant; two minimal updates applied |
| Skills (4) | All present, IDs match frontmatter, no duplicates, discovered by OpenCode |
| `skills-lock.json` | 4 entries, commits present, all content hashes verified |
| Playwright | Installed — version 1.65.2 |
| Chromium | Installed — build 1255, browser 159.0.8154.6 |
| Launch test | **Pass** (with a documented workaround for a corrupted Python stdlib file) |
| Blocker | One 0-byte CPython stdlib file prevents Playwright from starting normally |

---

## 1. `AGENTS.md`

Verified against the requested criteria:

| Requirement | Status |
| --- | --- |
| Concise Ethereal Co. context | Present — product, owner + salesperson roles, early-stage status |
| React 19 + Vite 8 + Supabase stack | Present — with JSX/no-TypeScript, plain CSS, Oxlint, no test suite |
| Token-efficient skill selection | Present — minimum-skill rules, per-task guidance, no redundant loading |
| Inspect before editing | Present — "Working method" step 1 |
| Security rules | Present — no `.env` access, public keys only, RLS over UI checks, no remote DB work |
| Git safety rules | Present — no commit/push/reset, no discarding work, stage specific paths |
| Avoids duplicating business docs | Present — links to `docs/PHASE_1_*` instead of restating requirements |

Updates applied (minimal, additive):

1. `webapp-testing` row now records the installed Playwright/Chromium versions and
   points to this document instead of saying Playwright is missing.
2. Added one line limiting Next.js/RSC rule application, since this app is a Vite SPA.

No other wording was changed; existing instructions were preserved.

---

## 2. Installed skills

| Skill | `SKILL.md` | Frontmatter `name` | Files | Purpose match |
| --- | --- | --- | --- | --- |
| `frontend-design` | Present | `frontend-design` | 2 (`SKILL.md`, `LICENSE.txt`) | Visual direction, typography, palette |
| `designing-user-experience` | Present | `designing-user-experience` | 2 (`SKILL.md`, `references/flow-patterns.md`) | Flows, forms, states, copy, destructive actions |
| `webapp-testing` | Present | `webapp-testing` | 6 (`SKILL.md`, `LICENSE.txt`, `scripts/with_server.py`, 3 examples) | Playwright-driven workflow verification |
| `vercel-react-best-practices` | Present | `vercel-react-best-practices` | 75 (`SKILL.md`, `README.md`, 108 KB `AGENTS.md`, `rules/*.md`) | React performance review |

- All directories exist under `.agents/skills/` with exactly one `SKILL.md` each.
- Directory name, frontmatter `name`, lockfile key, and advertised ID agree for all four.
- Supporting files are intact; the React skill's 70 rule files are the large but
  lazily-read part of that package.
- **No duplicates:** no `.opencode/skills`, `.claude/skills`, or global
  `~/.config/opencode/skills` directory exists; `npx skills list --json` reports
  exactly four project-scope skills.

Discovery confirmed against the running server:

```powershell
opencode api get "/api/skill?location%5Bdirectory%5D=<project path, URL-encoded>"
```

Returns `designing-user-experience`, `frontend-design`, `vercel-react-best-practices`
and `webapp-testing`, each resolved to its absolute
`.agents\skills\<id>\SKILL.md`, alongside the built-in `opencode`, `report` and
`browser` skills.

---

## 3. `skills-lock.json`

| Check | Result |
| --- | --- |
| Format | Version 2, four entries, no extras or duplicates |
| Sources | `anthropics/skills` (×2), `osmontero/opencode-skills`, `vercel-labs/agent-skills` |
| Commits | All 40-character SHAs, pinned per skill |
| Skill paths | Upstream `skillPath` recorded for each entry |
| Install mode | `copy` for all four |
| Content hashes | **All four match** the installed folders |
| Agent targeting | Not a lockfile field; expressed by the `.agents/skills` location and the `--agent opencode` install invocation |

Hashes were recomputed with the CLI's documented folder-hash algorithm (relative
paths, LF-normalised text files, `path\0len\0content` streaming SHA-256). The
implementation reproduced all three published test vectors before being trusted:

| Skill | Files hashed | Stored = computed |
| --- | --- | --- |
| `frontend-design` | 2 | Yes |
| `designing-user-experience` | 2 | Yes |
| `webapp-testing` | 6 | Yes |
| `vercel-react-best-practices` | 75 | Yes |

The lockfile was read only. It was not regenerated, reformatted, or replaced.

---

## 4. Playwright installation

### 4.1 State found

- Python 3.13.6 at `C:\Program Files\Python313\python.exe`; no project virtualenv.
- `playwright` absent from Python; no Node Playwright package; no Playwright browsers.
- `package.json` untouched throughout (no Node dependency added).

### 4.2 Installed

```powershell
python -m pip install --user playwright
python -m playwright install chromium
```

| Item | Value |
| --- | --- |
| Playwright (Python) | **1.65.2** |
| Location | `C:\Users\harsh\AppData\Roaming\Python\Python313\site-packages` (user scope, outside the repo) |
| Chromium build | **1255** |
| Browser version | **159.0.8154.6** |
| Executable | `C:\Users\harsh\AppData\Local\ms-playwright\chromium-1255\chrome-win64\chrome.exe` |
| Also installed | headless shell 1255, FFmpeg 1013, WinLDD 1007 (~743 MB total) |
| CLI entry point | `python -m playwright` (the `.exe` shim is not on `PATH`) |

No other browser, package, or project dependency was installed. No repository
script was downloaded or executed.

### 4.3 Blocker found and worked around

The first launch attempt failed before Chromium started:

```
AttributeError: module 'asyncio.windows_utils' has no attribute 'Popen'
```

**Cause:** `C:\Program Files\Python313\Lib\asyncio\windows_utils.py` is **0 bytes**
on disk (dated with the original install, 6 Aug 2025). This is a pre-existing
corrupted Python installation, not a Playwright or project problem. Because
Playwright's Python driver starts its Node process through `asyncio` subprocess
support, it cannot run while the file is empty.

**Proof the file is the defect:** an intact copy of the same CPython 3.13.6 module
exists in `C:\Program Files\MySQL\MySQL Shell 8.0\lib\Python3.13\Lib\asyncio\windows_utils.py`.
It is byte-identical to the official `python/cpython` v3.13.6 file
(5,060 bytes, sha256 `e6fcffefa2521666bc2aed0f5caf8e862c1c1014ad12d2ab5fbce09c2df9c6f0`).

**Permanent fix (requires an elevated shell):**

```powershell
Copy-Item "C:\Program Files\MySQL\MySQL Shell 8.0\lib\Python3.13\Lib\asyncio\windows_utils.py" `
          "C:\Program Files\Python313\Lib\asyncio\windows_utils.py" -Force
python -c "import asyncio.windows_utils as w; print(hasattr(w, 'Popen'))"   # expect True
```

Alternatively, repair or reinstall CPython 3.13 (`winget upgrade --id Python.Python.3.13`),
which restores the stdlib. Playwright does not need reinstalling after a repair.

**Verification workaround used here:** a session-scoped `sitecustomize.py` in the
temp directory reloads that same official module source at interpreter start-up
when `PYTHONPATH` points at it. Nothing in the Python installation or the project
was modified.

```powershell
$env:PYTHONPATH="C:\Users\harsh\AppData\Local\Temp\opencode\pyshim"
python your_playwright_script.py
```

Use this only until the file is repaired; the shim is not part of the project.

### 4.4 Browser launch test

Script: `sync_playwright()` → `chromium.launch(headless=True)` → `set_content()` with
a local HTML fragment → read text → close. No external network access, no project
data transmitted.

```
playwright driver ok
browser version: 159.0.8154.6
page text: tooling check
title tag present: True
launch test: PASS
```

Without the shim the same script reproduces the `windows_utils` error above. That
failure is reported as a blocker, not as a successful test.

---

## 5. Skill activation strategy

| Skill | Activate when | Typical trigger |
| --- | --- | --- |
| `frontend-design` | Visual design, styling, layout, typography, palette | New screen, restyle, visual direction |
| `designing-user-experience` | Journeys, forms, validation, states, copy, destructive actions | Approval flow, empty/loading/error states, confirmations |
| `webapp-testing` | Browser-level functional verification | After UI or auth-flow changes, before claiming a flow works |
| `vercel-react-best-practices` | React performance and code review | Data fetching, re-render or bundle work, refactor review |

Rules:

- **One skill per task** by default; add a second only when the task genuinely spans
  two jobs (e.g. redesign plus flow definition).
- **Never both design skills** for routine coding — visual direction and behavioural
  UX are separate passes.
- **No testing skill** for documentation, configuration, or tooling tasks.
- **Next.js rules:** this is a Vite SPA. Apply server-action, `next/dynamic`, RSC and
  Suspense-streaming rules only when relevant; prefer the client-side, re-render,
  rendering and JS categories.
- **No multi-agent fan-out** for a single task; one agent reads the one relevant skill.
- Load `SKILL.md` plus only the specific reference or rule file needed.

---

## 6. Git

| Item | State |
| --- | --- |
| Branch | `main` |
| Tracked modifications | `reports/ETHEREAL_PHASE_0B_STAGING_DATABASE_SECURITY_ASSESSMENT.pdf` (pre-existing, binary 17,847 → 268,935 bytes) |
| Untracked, pre-existing | Phase 1 docs (4), Phase 0C/1 reports (4), inspection SQL (2), `supabase/migrations/` |
| Untracked, this setup | `.agents/`, `skills-lock.json`, `AGENTS.md`, `docs/OPENCODE_SKILLS_INVENTORY.md`, `reports/ETHEREAL_OPENCODE_SKILLS_SETUP_REPORT.pdf` |
| Added by this verification | `docs/OPENCODE_TOOLING_VERIFICATION.md`, this report |
| Modified by this verification | `AGENTS.md` (two additive lines) |
| Accidentally modified | None — `git status -- src supabase/config.toml` is empty |
| Staged / committed / pushed | Nothing |

---

## 7. Remaining blockers and next steps

1. **Repair the corrupted stdlib file** (admin): the `Copy-Item` command in §4.3, or
   a CPython repair install. Until then, Playwright needs the `PYTHONPATH` shim.
2. **Optionally delete the shim** after the repair:
   `Remove-Item "C:\Users\harsh\AppData\Local\Temp\opencode\pyshim" -Recurse`.
3. **First real webapp test** will need a running dev server (`npm run dev`, Vite on
   port 5173) and the skill's `scripts/with_server.py` helper.
4. **Licence note unchanged:** `vercel-react-best-practices` declares MIT in its
   frontmatter only; there is no LICENSE file upstream.
5. **Commit decision is yours:** `.agents/`, `skills-lock.json`, `AGENTS.md` and the
   two docs are ready to review and commit together.
