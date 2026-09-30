# Northstar Lab

An operations console for a small research and product discovery team. This first release demonstrates the workflow without invoking AI models. The backend stores task and event history in PostgreSQL when `DATABASE_URL` is configured. In local development it uses temporary in-memory state.

## Workflow

Project manager → team lead → research worker → quality reviewer → revision → final review. Each transition is recorded as an event. The dashboard polls for changes every 1.5 seconds. No model calls are made in demo mode.

## Agent skills and next milestone

Role contracts are versioned in [`agents/skills`](agents/skills), with a shared [work and reporting protocol](agents/PROTOCOL.md). They describe the CTO orchestrator, project manager, research team lead, research worker, and independent quality reviewer. These are specifications for the future agent runtime, **not active AI agents**.

The next implementation step is to connect durable storage, then add:

- An append-only `agent_messages` log and `daily_reports` records in the backend, keyed by run and task. The backend validates role and handoff transitions and records actual token/cost usage.
- An “Agent conversation” panel beside each task in the frontend, showing short assignments, findings, reviews, decisions, and linked evidence. Stream new messages with server-sent events; show a recent-history fallback after reconnect.
- A “Daily reports” view for per-agent reports and the CTO's owner-facing roll-up. Generate reports using a real scheduler at the owner's chosen time and timezone; uptime pings are not a scheduler.

Show auditable work summaries, not hidden model reasoning or secrets. Add authenticated access before using the conversation for private research or giving agents external write capabilities.

## Run locally

In one terminal:

```sh
cd backend
npm install
npm start
```

In another:

```sh
cd frontend
npm install
npm run dev
```

The frontend defaults to `http://localhost:8787`. Set `VITE_API_URL` for a different backend. Set `DATABASE_URL` on the backend for durable storage. The browser creates a random workspace key and stores it locally; keep this release for demonstration data only.

## Deployment

- Frontend: Vercel, root directory `frontend`, build command `npm run build`, output directory `dist`, environment variable `VITE_API_URL` set to the Render backend URL.
- Backend: Render Node web service, root directory `backend`, build command `npm install`, start command `npm start`, environment variable `DATABASE_URL` from a PostgreSQL database.

Render free web services sleep after inactivity and free PostgreSQL databases expire after 30 days. An always-on production system requires a durable database and paid or event-driven compute.

## Next engineering milestone

Connect a model and source tools behind the same workflow state machine, add authenticated accounts, enforce per-task token and money caps, and add independent evidence checks. Do not treat demo events as research findings.
