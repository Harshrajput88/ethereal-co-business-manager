# Ethereal Co. Business Manager

A React + Vite web dashboard for managing an Ethereal Co. bottled-water business.
It is designed to be used by a business **owner** and approved **salespeople**,
with Supabase providing authentication and the (intended) database backend.

> **Status: early-stage / partially built.** The application currently includes a
> working login screen, registration, an owner approval workflow, and a styled
> dashboard shell. Most business features (sales, stock, pricing, payments,
> reports) are still placeholders. See [Current implementation status](#current-implementation-status).

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

There is no TypeScript, no router, no state-management library and no test suite.

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

`src/lib/supabase.js` throws at startup when the URL or key is missing.

## Development commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Start the Vite dev server with hot reload |
| `npm run build` | Produce a production build in `dist/` |
| `npm run preview` | Preview the built output locally |
| `npm run lint` | Run Oxlint over the source |

## Current implementation status

| Area | Status | Notes |
| --- | --- | --- |
| React + Vite app shell | **Implemented** | Builds successfully; single-page dashboard, no router |
| Responsive mobile layout | **Implemented (CSS)** | Breakpoints at 1500 / 1100 / 760 / 600 / 380 px; not verified on real devices |
| Supabase client wiring | **Implemented** | Client created from env vars in `src/lib/supabase.js` |
| Live Supabase connectivity | **Not verified / failing** | The project URL stored in `.env.local` no longer resolves in DNS (checked 2026-11-15) |
| Email + password authentication | **Implemented (unverified)** | `signInWithPassword`, `signUp`, `onAuthStateChange`, sign-out |
| Owner / salesperson roles | **Partially implemented** | Role read from `profiles.role`; UI gates owner-only screens. Enforcement depends on RLS, which could not be inspected |
| Registration + owner approval | **Implemented (unverified)** | New accounts default to `pending`; owner can approve / disable / re-enable |
| Profile page + avatar upload | **Implemented (unverified)** | Uses storage bucket `profile-picture` and RPC `update_my_avatar` |
| Daily sales dashboard | **UI only** | All four stat cards and inventory numbers are hardcoded to `0` |
| Transactions list | **UI only** | Always renders the "No sales recorded today" empty state |
| Shop management | **Not implemented** | No shops table, screen or logic |
| Product management | **UI only** | Two products hardcoded in `src/App.jsx` |
| Shop-specific pricing | **Not implemented** | No pricing model or UI |
| Sales recording | **Not implemented** | "Sales" nav item shows a "coming next" placeholder |
| Bottle / carton calculations | **UI only** | Carton sizes appear only as static text (24 / 12 bottles) |
| Inventory & stock movements | **UI only** | Inventory page is a placeholder; overview cards show `0` |
| Cash / UPI payments | **Not implemented** | No payment capture or storage |
| Credit & outstanding balances | **UI only** | Static "Outstanding ₹0.00" card only |
| Payment verification | **Not implemented** | – |
| Reporting | **Not implemented** | "Reports" nav item shows a placeholder |
| Expenses / Customers | **Not implemented** | Nav items show placeholders |
| RLS policies | **Not verified** | Database unreachable during audit; cannot confirm policies exist |
| Deployment readiness | **Not ready** | Build passes, but backend is unreachable and features are incomplete |

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
- Oxlint reports two React warnings in both `App.jsx` and `App-backup.jsx`
  (impure `Date` call during render; `setState` inside an effect). No lint errors.
- The Supabase project referenced by `.env.local` is unreachable; authentication and
  database behaviour therefore cannot be confirmed until the project is restored or
  a new project is configured.
- An unrelated, empty public repository (`Harshrajput88/Etheral-Business-Manager`)
  still exists on the GitHub account. It contains no code or secrets; clean-up
  (make private or delete) needs owner approval.
