# Agent work protocol

This is the contract for future model-backed runs. The current dashboard is a deterministic demo; these skills do not start agents or spend tokens by themselves.

## Visible conversation

Persist a short, append-only work message whenever an agent assigns work, shares evidence, requests revision, makes a decision, reports a blocker, or hands off. Each message has `run_id`, `task_id`, `agent_id`, `recipient_id`, `kind`, `summary`, `artifact_refs`, `evidence_refs`, and a server-assigned timestamp. `kind` is one of `assignment`, `finding`, `review`, `decision`, `blocker`, `handoff`, or `status`. Link evidence and artifacts instead of copying long text into every message. Do not expose hidden reasoning, private credentials, or raw tool output in the conversation; show concise decisions and supporting evidence that the owner can audit.

The backend is the source of truth for messages, task state, and token/cost usage. Agents can propose state changes, but the orchestrator validates role, task ownership, and allowed transitions before saving them. A reviewer must not review their own work. A task is complete only after an accepted review and project-manager closure. Escalate unresolved scope, risk, or spending decisions to the human owner.

## End-of-day report

At the owner's configured timezone and schedule, each active agent produces one report with: `date`, `agent_id`, `completed`, `in_progress`, `blocked`, `decisions`, `evidence_refs`, `tokens_used`, `estimated_cost`, `next_actions`, and `needs_owner`. Empty work is reported as "No assigned work today" rather than invented progress. The CTO combines these reports into a short owner-facing summary with outcomes, risks, budget, and decisions needed. Store reports in the backend and show them in the dashboard; a later notification channel can link to the report.

## Cost and quality gates

Use the task's approved token, cost, time, and source limits. Do not create work merely to keep agents busy. Reuse a concise shared context and stable role instructions; send only the task-specific delta at handoff. Stop at the budget cap and report what remains. Claims need traceable sources; label hypotheses and unknowns. Research materials committed to GitHub must be lawfully shareable; otherwise store citation metadata and links, not copies.
