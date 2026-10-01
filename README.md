# Northstar Lab

Northstar Lab is an operations console for a research team that investigates real problems, checks evidence independently, and turns promising gaps into software-product opportunities. The long-term goal is a supervised team of AI agents whose work, decisions, costs, and daily progress are visible to the human owner.

**Current status:** The [live dashboard](https://northstar-lab-woad.vercel.app/) offers a scripted workflow demo, a real owner-operated Claude Research worker, and a separate Claude Quality reviewer invocation. [Agent chats](https://northstar-lab-woad.vercel.app/#chats) has task threads and direct owner messages to either live role. [Approval inbox](https://northstar-lab-woad.vercel.app/#approvals) holds QA-accepted drafts for the owner's decision. [Worker usage](https://northstar-lab-woad.vercel.app/#usage) records completed calls by role. Both roles use the same local Claude subscription, so QA is a separate source-checking pass, **not cross-provider independence**. CTO, manager, lead, daily reports, and account login remain planned. Claude runs only while the owner-operated worker process and computer stay awake.

## The team

| Role | Responsibility | Output |
| --- | --- | --- |
| [CTO orchestrator](agents/skills/cto-orchestrator/SKILL.md) | Sets bounded priorities, watches quality and cost, escalates decisions to the owner. | Executive decisions and a daily owner report. |
| [Project manager](agents/skills/project-manager/SKILL.md) | Turns an approved objective into tasks, acceptance criteria, owners, deadlines, and budgets. | Task plan and accepted/blocked status. |
| [Research team lead](agents/skills/research-team-lead/SKILL.md) | Assigns distinct work, manages handoffs and revisions, prevents duplicated effort. | Worker assignments and review-ready packets. |
| [Research worker](agents/skills/research-worker/SKILL.md) | Searches sources and produces a traceable answer to one question. | Evidence-backed research packet. |
| [Quality reviewer](agents/skills/quality-reviewer/SKILL.md) | Independently checks claims, sources, limitations, and acceptance criteria. | Accept, revise, or block decision. |

The owner is above the team: agents can recommend a direction, but the owner approves major changes in product scope, access, or spending. The shared [agent work protocol](agents/PROTOCOL.md) defines visible messages, reports, and quality gates.

## End-to-end workflow

```mermaid
flowchart TD
    Owner[Human owner: goal, constraints, approvals] --> CTO[CTO: bounded objective and priorities]
    CTO --> PM[Project manager: scoped task and acceptance criteria]
    PM --> Lead[Team lead: assignment and budget]
    Lead --> Worker[Research worker: evidence-backed packet]
    Worker --> QA[Independent quality reviewer]
    QA -->|Revise| Lead
    QA -->|Blocked or needs a new decision| PM
    QA -->|Accepted| PM
    PM -->|Closes accepted task| CTO
    CTO -->|Daily roll-up and decisions needed| Owner
```

1. **Set direction.** The owner states a problem area and constraints. The CTO proposes a bounded objective and checks that it fits the available time and money. A materially new direction goes back to the owner for approval.
2. **Plan the task.** The project manager writes a specific research question, expected deliverable, source/date bounds, acceptance criteria, deadline, owner, independent reviewer, and token/cost cap.
3. **Assign work.** The team lead splits the task only where separate workers can investigate distinct questions or methods. Each worker receives the smallest useful context and a stop condition; agents are not kept busy for its own sake.
4. **Research and record evidence.** A worker captures the search approach, source links or DOIs, publication dates, supporting results, contradictions, limitations, and open questions. For a ten-year literature review, the task specifies the exact date window. The worker labels hypotheses and does not claim novelty from an incomplete search.
5. **Hand off for independent review.** The worker submits a compact research packet and evidence links. A different agent checks pivotal sources against the original acceptance criteria. The worker cannot approve its own work.
6. **Resolve the review.** QA returns **accept**, **revise**, or **block**, with a reason. Revisions return through the lead to the worker; blocked work goes to the project manager or owner when a new decision or access is needed.
7. **Close or continue.** The project manager closes only accepted work. A promising gap becomes a candidate for further validation, not an automatic product decision. The CTO chooses the next bounded investigation or asks the owner to decide.
8. **Report daily.** Each active agent reports completed, in-progress, and blocked work; evidence and decisions; actual token/cost usage; and next actions. The CTO combines these into a short owner-facing summary at the owner's configured time and timezone. No activity is reported as no activity, never invented progress.

The [Agent chats view](https://northstar-lab-woad.vercel.app/#chats) has task threads and direct-message views, backed by task-linked, append-only messages. The owner can address the Research worker or Quality reviewer individually; these direct answers do not change a formal verdict. After a real `finding`, the backend automatically queues a separate QA call. QA publishes `ACCEPT`, `REVISE`, or `BLOCK` with checked links; `ACCEPT` goes to the [Approval inbox](https://northstar-lab-woad.vercel.app/#approvals), where an explicit browser-workspace decision approves it or requests revision. The local worker key cannot make that decision. This is not yet a true owner login: protect the browser workspace key and do not use the pilot for private material. Scripted demo handoffs remain labeled. Hidden reasoning, credentials, and raw tool output are not published. Per-agent and CTO daily reports remain a future milestone.

## Research artifacts and product decisions

Accepted research packets should include a citation index, concise findings, limitations, conflicting evidence, and a proposed test of the identified gap. The GitHub repository will hold versioned, shareable findings and decision records. For papers or images that cannot legally be redistributed, store metadata and links rather than copies. A product idea moves forward only when evidence, user need, feasibility, and QA findings support a small validation experiment.

If a candidate survives that test, the CTO presents an evidence-backed **go / revise / stop** recommendation to the owner. With owner approval, the project manager can turn it into an MVP specification, engineering tasks, code review, deployment, and user-feedback measurements. This product-building phase will need its own engineering and product-validation skills; the five skills in this repository cover the research organization only. Feedback and failed assumptions return to the research backlog instead of being hidden behind a launch.

## Cost, safety, and operating rules

- The backend owns task state, allowed handoffs, message history, and measured token/cost usage. A model response alone cannot mark a task complete.
- Model calls occur for assigned work and necessary review, **not** for dashboard refreshes or idle chatter. Use short handoffs, stable role instructions, linked artifacts, and per-task limits.
- Stop at a task's time, source, token, or money cap and report what remains. Require owner approval before expanding scope or granting external write access.
- Add authenticated access before storing private research in the chat. Do not display API keys, private source text, or hidden reasoning in public UI messages.

## Worker routing and token accounting

The [Worker usage view](https://northstar-lab-woad.vercel.app/#usage) shows role assignments, Claude pairing/online status, and completed calls **generated by this workspace only**. It does not read account-wide subscription usage or reset times. Demo handoffs do not count. Interrupted or failed Claude calls may not return a final usage record, so provider totals can be higher than this ledger. The backend's read-only `GET /api/usage` returns per-provider and per-agent totals plus the latest 100 call records. The append-only PostgreSQL `usage_events` ledger is task-linked, workspace-scoped, and idempotent by provider/request ID. Browser workspace keys cannot submit real findings; the local worker uses a separate one-time pairing key stored only as a hash on Render. In-memory storage supports local development.

| Agent | Current worker | Rationale |
| --- | --- | --- |
| CTO, project manager, team lead | Codex via OpenAI | Planning, coordination, and owner reporting |
| Research worker | Claude via Anthropic | Focused investigation and evidence packet |
| Quality reviewer | Claude via Anthropic | Separate invocation and source-checking context; not cross-provider QA |

The code includes normalizers for OpenAI and Claude response token fields. Cached input and reasoning output are shown as **subsets** of input/output, not extra tokens. Claude cache-write and cache-read tokens are included once in total input. The Claude worker submits measured usage after a successful run. Codex is still a planned route; there is no OpenAI account connection, automatic account rotation, or account-token entry in the dashboard.

## Persistent context and owner chat

In [Agent chats](https://northstar-lab-woad.vercel.app/#chats), the owner can edit the **project goal** and **memory notes** and message either the Research worker or Quality reviewer about a selected task. A question is saved immediately, queued if the local worker is offline, and answered when that worker runs. Task threads include research, review, and owner decisions; direct-message views show each worker's one-to-one owner conversation. Older messages remain in PostgreSQL beyond the dashboard's latest-200 display. Chat answers are not QA-approved findings.

Each Claude research run or chat answer receives the saved goal and notes, current task title/brief/status, up to 12 recent real messages on that task, and five recent real cross-task work messages. Message excerpts are capped at 700 characters apiece. **Formal QA is different:** it receives only the task brief, latest research draft, and its evidence links in a fresh model call, without the research chat history. The full PostgreSQL ledger persists beyond those bounded context packets. Important long-lived decisions should be put in memory notes. No hidden reasoning or OAuth credential is stored in chat.

## Run the Claude research worker

This is for the owner's own Claude Code subscription on an owner-operated Mac or private machine. It does **not** relay an OAuth token or API key to Render. [Claude Code supports `claude -p` non-interactive output and usage metadata](https://code.claude.com/docs/en/headless), and [Anthropic currently says this usage draws from subscription limits](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan). [Anthropic warns against routing third-party traffic through subscription limits](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account); do not turn this personal companion into a hosted multi-user subscription proxy.

1. Install the [official Claude Code CLI](https://code.claude.com/docs/en/overview) and sign in with `claude auth login`. Do not use `--console` or set `ANTHROPIC_API_KEY` for this subscription worker. In `backend/`, run `npm run worker:claude -- --check` to verify login without a model call.
2. On the [Worker usage page](https://northstar-lab-woad.vercel.app/#usage), select **Pair local Claude**, then **Copy one-time worker key**. Keep it private. Rotating the key revokes an existing worker; the key is never saved in browser storage or GitHub.
3. From the repository's `backend/` directory on that same Mac, run:

   ```sh
   NORTHSTAR_WORKER_KEY="$(pbpaste)" npm run worker:claude
   ```

   The command watches for queued work while the computer and Terminal process stay running. Use `npm run worker:claude -- --once` with the same environment variable to process at most one queued item (review, question, or research task). After updating the repository, **restart any already-running worker process** so it can claim QA jobs; the paired key does not need rotating.
4. Add a narrowly scoped task on the dashboard and click **Queue for Claude**. The worker uses web search/fetch only and submits a source-linked draft. The backend automatically queues the separate reviewer pass. Read its `ACCEPT`, `REVISE`, or `BLOCK` verdict in [Approval inbox](https://northstar-lab-woad.vercel.app/#approvals). An accepted draft still needs the owner's approval; a rejected or blocked draft can be re-queued for research. Direct questions to either worker use the same local process but do not change the formal QA status.

Research and QA runs use Sonnet, at most four model turns and an approximately $0.50 **list-price** budget guard each (not a claim about subscription billing), plus a six-minute timeout. Direct chats allow three turns and a $0.30 guard. Claude has no file, shell, browser automation, or MCP tools in this pilot. The reviewer can still miss errors; treat citations as unverified until checked by a person for consequential decisions. The local worker key can authorize draft and review submission in this workspace; do not paste it into chat or share it. If the Mac sleeps, the worker stops; UptimeRobot does not run it.

## What works today versus what comes next

| Capability | Status |
| --- | --- |
| Dashboard and scripted PM → lead → worker → QA → revision → CTO walkthrough | Live demo |
| Task/event API on Render and frontend on Vercel | Live demo |
| UptimeRobot check of the API `/health` endpoint every five minutes | Configured |
| [Agent chats](https://northstar-lab-woad.vercel.app/#chats) with task threads and direct owner-to-worker messages | Live for Research worker and Quality reviewer; other roles are scripted/planned |
| [Approval inbox](https://northstar-lab-woad.vercel.app/#approvals) and review state machine | Live; separate Claude QA verdict, then explicit owner approval/revision |
| PostgreSQL persistence of demo tasks, events, and agent messages | Connected on Render; the free database expires October 30, 2026 unless upgraded |
| [Worker usage view](https://northstar-lab-woad.vercel.app/#usage), Codex/Claude routing, and usage ledger | Live; Claude calls record usage after successful runs |
| Owner-operated Claude Code research worker with separate pairing key | Implemented; runs only while the owner starts and keeps the local process alive |
| Durable project goal, memory notes, and bounded context for Claude runs | Implemented; full message history is retained, but only selected recent excerpts enter each model call |
| Versioned role skills and shared message/report contract | Research worker and Quality reviewer instructions used; other roles remain specifications |
| Cross-provider QA, per-agent daily reports, CTO daily roll-up | Planned |
| Full ten-year literature review, user-demand validation, authenticated users | Planned |

The backend saves append-only `agent_messages`, task events, and measured `usage_events` for completed Claude runs. The dashboard puts task creation and Claude setup first, keeps the planned role diagram collapsible, and labels real work separately from demos. While the tab is visible, the frontend polls workflow updates every 1.5 seconds and usage every 30 seconds; background tabs stop polling and refresh when reopened. The next engineering milestones are owner authentication, cross-provider QA if an approved route becomes available, explicit user-demand validation, a safe artifact/research repository workflow, and durable per-agent/daily reports. A separate scheduler will generate reports at the owner's chosen time. **UptimeRobot is a health check and keep-alive, not a job scheduler or Claude worker.**

The owner wants subscription OAuth, **not API-key billing**. [OpenAI documents ChatGPT-plan usage for open-source/local apps](https://developers.openai.com/siwc/token-sharing-open-source), including a Codex app-server path; a paid or remotely hosted app must request access first. We do **not** proxy either account's subscription tokens through the public Render app. No OAuth credentials appear in the browser, GitHub, or agent messages. Do not use chat-share links or rotate subscription accounts to evade limits.

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

The frontend defaults to `http://localhost:8787`. Set `VITE_API_URL` for a different backend. Set `DATABASE_URL` on the backend for durable storage. The browser creates a random workspace key and stores it locally; use this release for demonstration data only.

Run the backend usage tests with `npm test` from `backend/`.

## Deployment

- Frontend: Vercel, root directory `frontend`, build command `npm run build`, output directory `dist`, `VITE_API_URL` set to the Render API URL.
- Backend: Render Node web service, root directory `backend`, build command `npm install`, start command `npm start`. Set `DATABASE_URL` to use PostgreSQL.
- Health endpoint: `GET` and `HEAD` on `https://northstar-lab-api.onrender.com/health` return HTTP 200 when the API is healthy. UptimeRobot checks this endpoint every five minutes.

Render's free web service can still restart, and its free PostgreSQL database has a limited lifetime. The keep-alive does not replace durable storage or guarantee production uptime.
