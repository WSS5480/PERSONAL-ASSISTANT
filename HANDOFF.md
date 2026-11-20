# HANDOFF — My Assistant

Read this first. Update it in the **same commit** as every code change (change log, decisions, open items).

## Start here

**Who the owner is and how he works**
- Steve — business owner (furniture retail stores organized in districts; also builds and sells apps hosted on Render). Not a developer.
- Terse, informal, often voice dictation from his phone. Phone-first; also uses a computer.
- Wants concise, practical answers with the reasoning included.

**Session rules**
- The session holder is the **manager**: it hires the coders and reviewers and swaps them out itself. All agents (manager, coders, reviewers) run on **Opus 5.5**.
- Reviewers report to the manager and **never push**. A reviewer may change code only if it tells the manager, and the manager verifies before anything ships.
- The owner's **stop** button kills running agents. Plain messages from him while work is running do **not** stop the work.
- When telling the owner what to set on Render, give the **exact environment variable name** (e.g. `ANTHROPIC_API_KEY`) — labels with spaces or dashes don't work there.
- To-do lists for the owner: **numbered** items (so he can reply by number), each with links and step-by-step instructions.
- **Always end replies to the owner with the app links** (live app URL once deployed, Render dashboard, GitHub repo `WSS5480/personal-assistant`).
- Every code change updates HANDOFF.md in the same commit.

**UI rules (every screen, every change)**
- Phone-first and also good on a computer. **No sideways-scrolling tables**: wrapped cards/fields and dropdown pickers. Nothing may overflow horizontally at 360px.
- Any header sits over its data (numbers right-aligned, text left-aligned).
- Summary numbers/tiles drill down to their detail, with a back button.
- Floating elements (mic, approval card, nav) never cover other UI or the last message. (Layout is a flex column — header / notices / scrolling view / composer / nav — nothing is position:fixed over content.)
- Clean, professional, large tap targets (48px+), light and dark.
- Installable PWA; service worker caches the shell only, never `/api`.
- Escape all rendered text: the front end builds DOM with `textContent` only (helper `h()` in `public/app.js`); never use `innerHTML` with user/model/tool content. CSP forbids inline scripts and inline styles — use classes.

**Approval rule (important)**
- Reads are free. Tools marked `needsApproval` (send email, create/delete calendar event, Render deploy/restart) are **never executed inside the model loop**. The server stores a pending action (user-scoped, expires in 30 min); the UI shows a card with exactly what will happen and Approve / Cancel. Typing or saying "yes/approve" or "no/cancel" while one is pending also works (applies to the most recent one).
- Only the user's approval (button or their own typed message) executes it; the server then feeds the result back so the assistant confirms. The model can never approve its own action; another user can never approve it.

## How it's built

```
src/
  server.js            entry: config -> DB -> app.listen
  app.js               Express app (security headers, CSRF guard, routes, static, Google OAuth GETs)
  config.js            env vars (only place that reads process.env, apart from PGLITE_DIR in server.js)
  db.js, migrations.sql  pg (DATABASE_URL) or embedded PGlite; idempotent migrations at startup
  crypto.js            scrypt passwords, AES-256-GCM secrets (key derived from SESSION_SECRET via HKDF), cookie HMAC
  auth.js              DB sessions + signed httpOnly cookie, role guards, CSRF header check, rate limiter, publicUser()
  audit.js             per-user audit log
  time.js              timezone conversion (Intl only)
  ai/loop.js           runAssistant({user, messages, tools, apiKey, ...}) — pure tool loop, no Express/DB
  ai/chat.js           chat service: history window, key selection, approvals, usage logging
  ai/keys.js           which Anthropic key a user runs on
  ai/prompt.js         system prompt (static cached block + dynamic block)
  tools/registry.js    tool registry: toolsForUser(), executeTool() (re-checks entitlement at execution)
  tools/*.js           memory, todos, reminders, notes, google, domo, repos, render
  integrations/*.js    Google OAuth/REST, Domo REST, GitHub REST, Render REST (all endpoint paths live here)
  routes/auth.js       /auth/status, signup, signin, signout, change-password
  routes/api.js        /api/* for the signed-in user (+ /api/apps owner-only)
  routes/admin.js      /api/admin/* (owner/admin)
public/                index.html, app.js, styles.css, sw.js, manifest.json, icons/
test/                  node:test suites (helpers.js has the fake fetch + fake Anthropic)
```

**Adding a tool:** create/extend a module in `src/tools/` exporting `[{ name, description, input_schema, needsApproval?, available(ctx), handler(ctx, input), summarize?(input) }]` and add the module to `MODULES` in `src/tools/registry.js`. `available(ctx)` is checked both when offering tools and at execution. `ctx.user` is the signed-in user (DB row), `ctx.fetch` is injectable for tests.

**Tool loop and the follow-on Domo Assistant:** `runAssistant` takes `{user, messages, tools, apiKey, model, system, executeTool, requestApproval}` and returns `{status, text, messages, pendingApprovals, clientCalls}`. A tool with `execution: 'client'` pauses the loop (`status: 'needs_client'` with the tool calls); the caller appends `tool_result` blocks to `messages` and calls `runAssistant` again. Not used yet — reserved for the Domo Assistant, where queries run in the user's browser under their own Domo login.

**Roles and access**
- `owner` = first account created (DB unique index allows only one). `admin` = promoted by the owner. `user`.
- `OWNER_EMAIL`: when set, only that email can create the first (owner) account, so nobody else can claim a fresh deploy. Set it before the first deploy.
- After the first account, self sign-up needs invite code == `SIGNUP_CODE`; empty `SIGNUP_CODE` = sign-up closed. Owner/admin can create people directly (temporary password, must change at first sign-in).
- Access level (`executive`/`district`/`store`) and district/store labels are **context for the system prompt only, not a security boundary**.
- Every row has `user_id`; every query filters by it. Admins cannot edit the owner account; only the owner can change roles and the "may use house key" toggle.

**AI keys:** owner uses `ANTHROPIC_API_KEY`. Everyone else uses their own key set in Admin → person → Anthropic API key. No key → reply "No AI key assigned — ask the admin." (no silent fallback). Owner-only toggle "may use house key" lets a person use `ANTHROPIC_API_KEY`. Usage (tokens, model, time, key source) is logged per request; Admin shows a tile per person → daily detail.

**Domo:** each person has their own Domo access token (Admin or their own Settings). Queries run only with the caller's token so Domo's PDP applies. No token → no Domo tools. Dataset catalog (Admin → Dataset catalog) is how the assistant knows what exists. Guards: single SELECT only, no comments/semicolons/DML/DDL keywords, 200-row cap with a truncation note, 30s timeout, audit (dataset + SQL + row count). SQL table name constant `DOMO_TABLE_NAME = 'table'` in `src/integrations/domo.js`. Column lists come from a `LIMIT 1` query cached per user+dataset for 30 min.

**Repositories:** `GITHUB_TOKEN` (owner's, read-only) stays server-side. Owner/admin grants repos per person (Admin → person → Repository access picker). Owner implicitly has every repo the token sees. Every call re-checks the grant, lower-cases names, rejects `..`/backslash/encoded traversal. Read-only.

**Render:** owner only (checked at offer and execution time; admins don't get it). `RENDER_API_KEY`. Reads: workspaces, services (+ last deploy), service status, deploys, logs. Approval: trigger deploy, restart. No delete/suspend.

**Google:** per-user OAuth (authorization code, offline access). `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `APP_URL`; redirect `APP_URL/auth/google/callback`; `state` stored server-side, single-use, bound to the signed-in user, 10-min expiry. Tokens encrypted; refresh handled.

## Run / test / ship

- Local: `npm install`, then `npm run dev` (loads `.env` if present; embedded DB in `./.pglite-data`) → http://localhost:3000. Without `SESSION_SECRET` a random one is used (sessions/stored keys reset on restart).
- Tests: `npm test` (node:test, no network, no real DB; fakes for fetch and Anthropic).
- Ship: commit on `main`; the manager verifies and a reviewer checks before push. Render auto-deploys from the repo.

**First deployment = the owner's personal instance** (sign-ups closed, he is the only account):
1. Render dashboard → New → Blueprint → pick repo `WSS5480/personal-assistant` → it creates `my-assistant` (web) + `my-assistant-db` (Postgres).
2. When asked for values: `ANTHROPIC_API_KEY` = his Anthropic key; `APP_URL` = the service URL (e.g. `https://my-assistant.onrender.com`, no trailing slash — can be filled after the first deploy); leave `SIGNUP_CODE` **empty**; the rest can stay empty until he wants that feature (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `DOMO_INSTANCE`, `GITHUB_TOKEN`, `RENDER_API_KEY`).
3. As soon as it's live, open the URL and create the owner account **immediately** (the first account becomes owner — see open item 6).
4. Do not create other users on this instance.

## Change log

- 2026-11-20 — Catalog: "Keep only dashboard & app data" (Admin → Dataset catalog). The owner said the AI got confused by the full raw dataset list and asked that it only use what his apps and dashboards show. For each catalog dataset the app looks up the cards built on it (`GET /api/content/v1/datasources/{id}/cards?drill=true`, admin's own token — MUST-VERIFY live), stores the card titles in `used_by`, and sets `active = false` on datasets no card uses. The assistant only lists and queries `active` datasets and searches `used_by`, so a question that names a dashboard or app finds the dataset behind it. A failed check changes nothing; each entry has a Hide/Show button. NOTE: the assistant queries the datasets behind dashboards — it does not read rendered cards, so card-level filters and Beast Mode calculations are not applied.
- 2026-11-20 — Phones kept showing the old screens after a deploy. All shell files (js, css, html, json) are now served `no-cache`, and `index.html` loads `app.js?v=N` / `styles.css?v=N`. RULE: bump that `v` number and the cache name in `public/sw.js` in every commit that changes `public/`.
- 2026-11-19 — Dataset catalog: added "Import all from Domo" (Admin → Dataset catalog). It lists every dataset the signed-in admin's own Domo token can see via `POST /api/data/ui/v3/datasources/search` (the endpoint Domo's own UI uses; not in the public API reference — MUST-VERIFY live) and adds the ones not already there. `domo_list_datasets` now returns at most 40 and asks the model to search by word. Reason: the owner wants all his Domo data available for questions without typing dataset IDs by hand.
- 2026-11-19 — First Render deploy (MY APPS workspace: web service `my-assistant` https://my-assistant-rjme.onrender.com, Postgres `my-assistant-db`, Oregon). The first boot ran out of memory because `DATABASE_URL` was not set and the embedded dev database loaded; the server now exits with a clear message in production when `DATABASE_URL` is missing.
- 2026-11-19 — Manager review (no reviewer agent on this build, per owner): added `OWNER_EMAIL` lock on the first account + test; the email approval card now shows the message body up to 3,000 characters instead of 300. Checked against real Postgres 16 locally.
- 2026-11-19 — v0.1.0 first build: accounts/roles, invite/closed sign-up, chat with browser voice in/out, tool loop with approval gate, memory/to-dos/reminders/notes, Google (Gmail + Calendar), Domo (per-user token + catalog), repo grants, Render (owner only), audit log, usage per user, admin console, PWA shell, Render blueprint, tests.

## Decisions (2026-11-19)

1. **Voice first** — Owner works by voice from his phone.
2. **Multi-user from the start** — He wants controlled access for other people; retrofitting user scoping is risky.
3. **No-build Node front end (vanilla HTML/CSS/JS)** — Few dependencies, cheap to run, easy for any session to change.
4. **Browser speech APIs for v1** — Free, no extra keys. Higher-quality voice is a later phase.
5. **Approval gate for outward/destructive actions** — Nothing leaves the building without the user saying yes; the model can't approve itself.
6. **Closed / invite-only sign-ups** — Protects the API bill and data.
7. **Per-user Domo tokens so Domo enforces PDP** — Domo decides each person's rows; app labels are context only.
8. **Dataset catalog** — Domo docs show no access-token endpoint to list/search datasets.
9. **Separate AI key per person, no silent fallback** — Owner requirement "separate AI APIs"; keeps costs attributable. House key only via an explicit owner-only toggle.
10. **Repo access by grant, read-only** — Owner requirement; least privilege.
11. **Render tools owner-only** — Owner requirement: "for me only with all Render data accessible".
12. **Owner's personal instance = this code with sign-ups closed** — One codebase, no fork.
13. **Two apps planned: My Assistant (this) and a Domo Assistant inside Domo for Domo personnel** — In the Domo app, staff sign in to Domo itself — we never collect Domo passwords.

## Open items / MUST-VERIFY before staff get access

1. **Domo PDP on access-token queries** — with a district-level Domo test user's token, confirm `POST /api/query/v1/execute/{datasetId}` returns only that user's PDP rows. Also confirm the SQL table-name convention (`FROM table`); if wrong, change `DOMO_TABLE_NAME` in `src/integrations/domo.js`.
2. **Render API endpoints** — verify every path in `src/integrations/render.js` against the live API (owners, services pagination/cursor shape, deploys, logs query params, trigger deploy, restart). Not verified live.
3. **GitHub token scopes** — use a fine-grained read-only token (Contents: read, Metadata: read) over the intended repos; confirm `/user/repos` and code search work with it.
4. **Google OAuth consent setup** — create a Web OAuth client, add redirect `APP_URL/auth/google/callback`, enable Gmail API + Google Calendar API, add test users while the consent screen is in testing (refresh tokens of "testing" apps expire after 7 days).
5. **Render plan names** in `render.yaml` (`starter` web, `basic-256mb` Postgres) — confirm on Render; adjust to budget.
6. **First-account race** — closed by `OWNER_EMAIL` (manager review, 2026-11-19): only that email can create the first account. If `OWNER_EMAIL` is ever left empty on a fresh deploy, whoever signs up first becomes owner.
7. Screens were reasoned for 360px but **not visually tested in a real browser** yet (only a scripted jsdom walk-through of every screen, the chat → approval card → approve flow and the reminder notice, which checks logic, not layout). Check on his phone: chat, admin, apps, voice in/out (iOS Safari speech behaviour especially).
8. Rate limits and the Domo column cache are in-memory (fine for one instance; revisit if scaled out).

## Next phases

1. **Domo Assistant** — runs inside Domo as a custom app for staff, phone + computer. Data queries execute in the user's browser under their own Domo login (`execution: 'client'` tools; loop already pauses for them). First step: test whether a Domo custom app can call this server (CORS/auth from inside Domo).
2. Geotab fleet tools.
3. My Apps console integration.
4. Texting via Twilio.
5. Vehicle controls.
6. Documents.
7. Proactive morning brief and alerts.
8. Higher-quality voice.
