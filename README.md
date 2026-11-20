# My Assistant

Voice-first, multi-user AI assistant (phone-first PWA) on the Claude API. Node 22 + Express, vanilla JS front end, Postgres.

**Start with [HANDOFF.md](HANDOFF.md)** — how the owner works, rules, decisions, open items.

```bash
npm install
cp .env.example .env      # optional; fill what you have
npm run dev               # http://localhost:3000 (embedded DB when DATABASE_URL is empty)
npm test                  # node:test, no network, no real DB
```

Deploy: Render Blueprint (`render.yaml`) — one web service + one Postgres. Health check `/healthz`.
