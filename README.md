# Ethereal Co. Business Manager

A React + Vite web dashboard for managing an Ethereal Co. bottled-water business.
It is designed to be used by a business **owner** and approved **salespeople**,
with Supabase providing authentication and the (intended) database backend.

> **Status: functional MVP implementation; cloud deployment remains gated.** The
> app includes role-aware authentication, business workflows, a local demo
> backend, additive SQL migrations, and PWA support. Run the local demo with
> `?demo=1`. Cloud workflows require the migrations to be reviewed and deployed
> to an isolated Supabase project; no remote project is contacted by the tests.

---

## Technology stack

| Layer | Technology | Version |
| --- | --- | --- |
| UI library | React | 19.3.1 |
| Build tool | Vite | 8.3.6 |
| Backend / auth | Supabase (`@supabase/supabase-js`) | 2.119.0 |
| Linter | Oxlint | 1.91.0 |
| Styling | Plain CSS (`src/App.css`, `src/index.css`) | – |
| Language | JavaScript (JSX, ES modules) | – |

There is no TypeScript, router, or state-management library. Node's test runner
executes local-backend workflow tests and SQL integration tests against PGlite.

## Project structure

```
ethereal-co/
├── public/
│   ├── assets/
│   │   ├── ethereal-hero.png              # dashboard hero banner
│   │   └── ethereal-sidebar-mountain.png  # sidebar artwork
│   ├── favicon.svg
│   └── icons.svg
├── src/
│   ├── assets/                            # imported static assets
│   ├── lib/
│   │   └── supabase.js                    # Supabase client (reads Vite env vars)
│   ├── App.jsx                            # entire UI + auth/profile/team logic
│   ├── App-backup.jsx                     # byte-identical backup copy of App.jsx
│   ├── App.css                            # all component styling + media queries
│   ├── index.css                          # global resets / base typography
│   └── main.jsx                           # React entry point
├── .env.example                           # placeholder environment variables
├── .gitignore
├── .oxlintrc.json
├── index.html
├── package.json
├── package-lock.json
└── vite.config.js
```

## Setup instructions

Requirements: **Node.js 20+** and npm.

```bash
# 1. Install dependencies
npm install

# 2. Create your local environment file
copy .env.example .env.local     # Windows
# cp .env.example .env.local     # macOS / Linux

# 3. Edit .env.local and paste your own Supabase project values

# 4. Start the development server
npm run dev
```

The dev server prints a local URL (normally <http://localhost:5173>).

> `.env.local` is git-ignored. Never commit real keys. A Supabase **service_role**
> key must never be placed in a `VITE_` variable, because everything prefixed with
> `VITE_` is shipped to the browser.

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | Yes | Your Supabase project URL, e.g. `https://<project-ref>.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | Yes | Supabase anon (or publishable) key, safe for browser use *only if RLS is enabled* |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | No | Alternative name accepted by the client if the anon key is absent |

`src/lib/supabase.js` creates the cloud client only when both public values exist. If they are absent, cloud mode is unavailable; the app does not substitute demo data unless `?demo=1` is explicitly requested.

## Development commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the Vite dev server with hot reload |
| `npm run build` | Produce a production build in `dist/` |
| `npm run preview` | Preview the built output locally |
| `npm run lint` | Run Oxlint over the source |
| `npm test` | Run local workflow tests and PGlite migration integration tests |

## Current implementation status

| Area | Status | Notes |
| --- | --- | --- |
| Authentication and roles | **Implemented; cloud unverified** | Owner/Admin/Salesperson, pending approval and disabled states; local backend tests enforce roles |
| Shops and assignments | **Implemented** | Submit, approve/reject, edit, assign salespeople, visits |
| Pricing | **Implemented** | Default and per-shop prices for both carton variants |
| Sales and invoices | **Implemented** | Cash/UPI sales confirm atomically; credit waits for approval; invoice snapshots and print-to-PDF |
| Inventory | **Implemented** | Stock receipt, adjustment, movement history, sale deductions and return dispositions |
| Payments and balances | **Implemented** | Payment claims, verification, allocation and receipts; only verified money reduces balances |
| Returns and expenses | **Implemented** | Submit/review/settle workflows and corresponding stock/ledger effects |
| Dashboard and reports | **Implemented** | Business metrics plus date, shop, salesperson and product reports/exports |
| Responsive PWA | **Implemented; browser checked** | Web manifest, offline app shell, icons, service worker; 390px check had no horizontal overflow |
| Database | **Implemented in nine ordered additive migrations; remote not deployed** | CI applies the nine-file release package to disposable PostgreSQL/PGlite test databases; the historical 20261117 drafts are excluded |
| Cloud readiness | **Release HOLD** | Staging is healthy but has no migrations or public business tables; two security warnings remain for `public.rls_auto_enable()`. Auth/JWT/PostgREST/RLS, the actual Supabase event trigger after ACL revocation, backup/restore and business acceptance still require staging validation. Production remains untouched |

## GitHub repository

- URL: <https://github.com/Harshrajput88/ethereal-co-business-manager>
- Visibility: **private**
- Default branch: `main`
- Commit history:
  - `9df830e` — *chore: initial commit of existing Ethereal Co. business manager app*
  - `1bacca8` — *docs: replace template README with accurate setup and status documentation*
  - `6bd7ab0` — *docs: add project audit report PDF*
  - `27c3bba` — *chore: mark PDF and image assets as binary to prevent line-ending corruption*

`.gitattributes` marks PDF and image files as binary so Git never rewrites their
line endings on checkout (which would corrupt the PDF).

## Audit report

A full technical audit is generated at `reports/ETHEREAL_PROJECT_AUDIT.pdf`.

## Notes / known issues

- `src/App-backup.jsx` is an exact duplicate of `src/App.jsx` (identical SHA-256).
  It is committed for history but is not imported anywhere.
- `npm run lint` completes with React hooks/compiler warnings; it reports no errors.
- `npm run build` completes; Vite reports the main JS chunk is above 500 kB.
- CI currently passes 53 automated tests and a PostgreSQL 17.12 real-concurrency rehearsal (73/73 checks), plus migration preflight, lint and production build. These disposable-database checks do not prove live Supabase Auth/JWT/PostgREST/RLS or restore readiness.
- The local demo is browser localStorage data and is not a production backend. Cloud release remains blocked pending staging-specific validation, verified backup/restore, independent review and end-to-end business acceptance.
- Public browser owner claiming is disabled; the designated owner must be provisioned by a trusted project operator. Cloud profile-picture uploads remain disabled until private Storage policies are reviewed and tested.
- The exact current test results and security review are recorded in
  `reports/implementation-report.pdf` when generated.
- An unrelated, empty public repository (`Harshrajput88/Etheral-Business-Manager`)
  still exists on the GitHub account. It contains no code or secrets; clean-up
  (make private or delete) needs owner approval.
