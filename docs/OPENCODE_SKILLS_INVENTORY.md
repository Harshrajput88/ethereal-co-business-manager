# OpenCode Skills Inventory — Ethereal Co.

Installed Agent Skills for the Ethereal Co. Business Manager, with provenance,
security review, overlap analysis, and maintenance procedures.

- **Collection date:** 17 November 2026
- **Agent:** OpenCode v2.3.0 (Windows, Node v26.13.0, npm/npx 11.6.2)
- **Scope:** project-level install in `C:\Users\harsh\Desktop\ethereal-business-manager\ethereal-co`
- **Lockfile:** `skills-lock.json` (version 2, `installMode: copy`)
- **Install method:** `npx skills add <repo> --skill <id> --agent opencode --copy -y`

---

## 1. Installed skills

| # | Skill ID | Upstream repository | Author | License | Installed path | Footprint |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `frontend-design` | [anthropics/skills](https://github.com/anthropics/skills/tree/main/skills/frontend-design) | Anthropic | Apache-2.0 (`LICENSE.txt` in skill dir) | `.agents/skills/frontend-design/` | 19.3 KB total (SKILL.md 9.2 KB) |
| 2 | `designing-user-experience` | [osmontero/opencode-skills](https://github.com/osmontero/opencode-skills/tree/main/skills/designing-user-experience) | osmontero | MIT (repository `LICENSE`) | `.agents/skills/designing-user-experience/` | 21.6 KB total (SKILL.md 14.8 KB) |
| 3 | `webapp-testing` | [anthropics/skills](https://github.com/anthropics/skills/tree/main/skills/webapp-testing) | Anthropic | Apache-2.0 (`LICENSE.txt` in skill dir) | `.agents/skills/webapp-testing/` | 22.4 KB total (SKILL.md 3.9 KB) |
| 4 | `vercel-react-best-practices` | [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills/tree/main/skills/react-best-practices) | Vercel Labs | MIT declared in `SKILL.md` frontmatter | `.agents/skills/vercel-react-best-practices/` | 224.1 KB total (SKILL.md 7.1 KB; `AGENTS.md` 108 KB + 70 rule files) |

Pinned commits (from `skills-lock.json`):

| Skill | Commit |
| --- | --- |
| `frontend-design` | `e4bb5d960d87126ff3b3a8af1a104b7db67560ba` |
| `webapp-testing` | `e4bb5d960d87126ff3b3a8af1a104b7db67560ba` |
| `designing-user-experience` | `1c181c198a7d4dee146946cbf97913047fa40364` |
| `vercel-react-best-practices` | `1a2c79d4e6c4a2283dc2c614b6538cbe1ed5ca62` |

### 1.1 `frontend-design`

- **Purpose:** distinctive, intentional visual design for new or reshaped UI —
  palette, typography, layout, and resistance to templated "AI default" looks.
- **Activation:** screens, layout, typography, colour systems, visual direction.
  Not for bug fixes, data logic, or documentation.
- **Compatibility:** plain Markdown, no scripts, no external fetches. Fully
  OpenCode-compatible.
- **Notes:** expects a design brief. Pass it the real Ethereal Co. context
  (bottled-water business, owner + salespeople) rather than letting it invent a
  subject.

### 1.2 `designing-user-experience`

- **Purpose:** design interface behaviour, not appearance — flows, state
  matrices (empty/loading/error/partial), forms and validation, copy, destructive
  actions, navigation, touch targets.
- **Activation:** forms, approval workflows, empty states, error handling,
  confirmation/undo, mobile behaviour.
- **Compatibility:** plain Markdown plus one reference file
  (`references/flow-patterns.md`), loaded only if needed. No scripts.
- **Notes:** its "companion skills" (`designing-frontend-interfaces`,
  `building-accessible-interfaces`, `reviewing-interface-quality`) are **not**
  installed; the cross-references are informational only and do not affect use.

### 1.3 `webapp-testing`

- **Purpose:** drive a local web app with Playwright to verify real workflows,
  capture console output and screenshots.
- **Activation:** after UI or auth-flow changes, when behaviour must be proven in
  a browser. Not for documentation, config, or pure static review.
- **Compatibility:** OpenCode-compatible instructions, but requires a **Python 3
  + Playwright runtime, which is not installed** in this project. Python 3.13.6
  exists; `import playwright` fails and no Node Playwright package is present.
- **Contents:** `SKILL.md`, `scripts/with_server.py`, three example scripts.
- **Security:** `with_server.py` uses `subprocess.Popen(..., shell=True)` to start
  dev servers. Only pass trusted project commands (`npm run dev`); never pass
  user-supplied or model-invented shell strings to it.

### 1.4 `vercel-react-best-practices`

- **Purpose:** 70 prioritised React/Next.js performance rules (waterfalls,
  bundle size, server/client data fetching, re-renders, rendering, JS micro-opt,
  advanced patterns).
- **Activation:** writing or reviewing React components, data fetching, bundle
  and render performance.
- **Compatibility:** OpenCode-compatible (Markdown + per-rule files).
- **Notes:** upstream directory is `skills/react-best-practices`; the skill's own
  frontmatter name — and therefore the installed ID — is
  `vercel-react-best-practices`.
- **Token discipline:** the package ships a 108 KB compiled `AGENTS.md` and ~70
  rule files. Read `SKILL.md` plus only the one or two relevant rule files. Do not
  load the compiled document wholesale.
- **Project fit caveat:** several rules target Next.js/RSC features (server
  actions, `next/dynamic`, Suspense streaming) that this Vite SPA does not use.
  Apply only the client-side, re-render, rendering, and JS categories here.

---

## 2. Rejected candidates

| Candidate | Source | License | Reason for rejection |
| --- | --- | --- | --- |
| `unslop` | [heydamir/unslop](https://github.com/heydamir/unslop/tree/main/skills/unslop) | CC-BY-4.0 | Substantial overlap with `frontend-design` (same job: avoid generic AI design). SKILL.md alone is 32 KB, plus six reference documents (~38 KB) and three Node scripts (~35 KB) including a 25 KB `story.mjs` and a Playwright-based `snapshot.mjs`. High token and process overhead for a capability already covered. |
| `web-design-guidelines` | [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills/tree/main/skills/web-design-guidelines) | No `license` field and no LICENSE file in the repository | The skill is a 1.2 KB stub that fetches rules at review time from a separate repository (`web-interface-guidelines/command.md`). Review criteria therefore change outside the pinned lockfile, provenance is weaker than the other Vercel skill, and its UI-review scope overlaps `designing-user-experience` and `frontend-design`. |

No other skill from the reviewed repositories was installed. `anthropics/skills`
and `vercel-labs/agent-skills` contain many unrelated skills (docx/pdf authoring,
`vercel-optimize`, etc.); they were not considered in scope.

---

## 3. Overlap and selection rules

```
Task type                     Primary skill                   Do not also load
--------------------------------------------------------------------------------
New visual design / restyle   frontend-design                 designing-user-experience
Forms, states, flows, copy    designing-user-experience        frontend-design
React refactor / perf review  vercel-react-best-practices      design skills
Browser workflow verification webapp-testing                   design skills
Docs, config, tooling         (none)                           all of the above
```

- At most **one** design skill per task. Visual direction and behavioural UX are
  separate jobs; loading both for routine coding doubles the instruction budget
  and produces conflicting guidance.
- `webapp-testing` is validation-only and should be loaded after the change, not
  during it.
- No two installed skills share a required script, reference file, or ID.

---

## 4. Token-efficiency measures

1. **Four skills instead of six.** Both rejected skills duplicated coverage
   already provided by installed ones.
2. **Only descriptions are persistent.** OpenCode advertises skills by
   description and loads a body on demand. The four installed descriptions total
   ≈1.1 KB (≈280 tokens) of always-on context.
3. **Bodies are opt-in.** All four `SKILL.md` files total ≈35 KB (≈9k tokens) —
   paid only when a skill is actually loaded, and never all at once in normal work.
4. **Lazy references.** `references/flow-patterns.md` and the React `rules/*.md`
   files are read individually, only when the task needs them.
5. **Compiled React guide excluded.** The 108 KB `AGENTS.md` in the Vercel skill is
   redundant with the rule files and is intentionally not read.
6. **Project instructions kept short.** `AGENTS.md` points to existing Phase 1
   documents instead of restating business requirements.
7. **Copy install mode.** Files live in the repo; no re-clone or network fetch is
   needed when a skill is used.

---

## 5. Security review

- **Provenance:** all four come from identifiable organisations/authors
  (Anthropic, Vercel Labs, osmontero) and are pinned to exact commits with content
  hashes in `skills-lock.json`.
- **Licensing:**
  - Anthropic skills carry Apache-2.0 `LICENSE.txt` inside each skill directory;
    the repository root has no LICENSE file (GitHub license API returns 404). The
    per-skill license governs.
  - `osmontero/opencode-skills` has an MIT repository license.
  - `vercel-labs/agent-skills` has **no repository LICENSE file and no license
    file in the skill directory**; `SKILL.md` declares `license: MIT`. Retained on
    the strength of that declaration and the Vercel Labs org; flagged as the
    weakest provenance of the four.
- **No install-time hooks:** no `postinstall`, plugin manifest, or auto-run entry
  point is executed by OpenCode. Skills are inert Markdown until loaded.
- **Scripts:** only `webapp-testing` ships executables
  (`scripts/with_server.py`, `examples/*.py`). Reviewed and not executed.
  `shell=True` is used to launch dev servers; treat its `--server` argument as
  trusted-code-only. No script reads credentials or writes outside the repo.
- **Instruction safety:** no skill instructs destructive commands, history
  rewrites, secret access, or network exfiltration. `frontend-design` may suggest
  taking screenshots for self-critique — that stays local.
- **Data exposure:** no `.env` file was read. `.gitignore` already excludes
  `.env*`, keys, and Supabase local state.
- **No application impact:** skills are documentation only; no application
  source, Supabase config, migration, or database was modified.

---

## 6. OpenCode discovery verification

Documented discovery locations (OpenCode V2): `.opencode/skills`, `.claude/skills`,
`.agents/skills`. The installer targets `.agents/skills`, which is a supported
shared path; no `.opencode` directory was created.

Verified through the running OpenCode server:

```powershell
opencode api get "/api/skill?location%5Bdirectory%5D=<project path, URL-encoded>"
```

Result — four project skills with absolute paths, plus OpenCode's built-in
`opencode`, `report`, and `browser` skills:

| ID | Path |
| --- | --- |
| `designing-user-experience` | `<project>\.agents\skills\designing-user-experience\SKILL.md` |
| `frontend-design` | `<project>\.agents\skills\frontend-design\SKILL.md` |
| `vercel-react-best-practices` | `<project>\.agents\skills\vercel-react-best-practices\SKILL.md` |
| `webapp-testing` | `<project>\.agents\skills\webapp-testing\SKILL.md` |

Additional confirmation:

- `npx skills list --json` reports four project-scope skills, all
  OpenCode-compatible, all `status: tracked`, no duplicates.
- Each installed directory contains exactly one `SKILL.md` whose frontmatter
  `name` matches its directory ID.
- No skill exists in more than one location (checked project root and
  `~/.config/opencode`; no global skills, no `.claude/skills`).

**Restart:** not required. OpenCode watches skill/config changes and advertised
the new skills immediately; `/reload` forces a refresh if a running session does
not show them.

Note: `opencode api get /api/skill` without the `location[directory]` parameter
defaults to the home directory and correctly returns an empty list — that is not
a discovery failure.

---

## 7. Update and removal

Run from the project root. Review the diff after any update; updates move the
lockfile to a new commit and re-copy files.

```powershell
# See what is installed
npx skills list

# Update one skill (keeps project scope)
npx skills update frontend-design

# Update all project skills
npx skills update --project

# Reinstall missing skills from skills-lock.json
npx skills experimental_install

# Remove a skill (also prunes it from skills-lock.json)
npx skills remove webapp-testing
```

Also commit `skills-lock.json` with `.agents/skills/` so the setup is
reproducible; do not edit installed skill files by hand, because the lockfile
hash will no longer match.

**Enable `webapp-testing`:** install its runtime before first use.

```powershell
python -m pip install playwright
python -m playwright install chromium
```

Until then, the skill's instructions are readable but its scripts cannot run.
