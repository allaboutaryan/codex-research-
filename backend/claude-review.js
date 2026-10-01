import { randomUUID } from 'node:crypto';
import { recordUsage } from './usage-store.js';
import { validateClaudeResult } from './claude-jobs.js';

const now = () => new Date().toISOString();
const maxAttempts = 2;
const leaseMinutes = 8;

export function reviewVerdict(summary) {
  const match = /^VERDICT:[ \t]*(ACCEPT|REVISE|BLOCK)[ \t]*(?:\r?\n|$)/i.exec((summary || '').trimStart());
  if (!match) throw new Error('Review must begin with VERDICT: ACCEPT, REVISE, or BLOCK');
  return match[1].toLowerCase();
}

export async function queueClaudeReview(pool, memory, workspace, id) {
  if (!pool) {
    const state = memory.get(workspace);
    const task = state?.tasks.find((item) => item.id === id && ['awaiting_review', 'review_failed'].includes(item.status));
    if (!task || !state.messages.some((message) => message.task_id === id && message.kind === 'finding' && !message.demo && message.evidence_refs?.length)) return false;
    Object.assign(task, { status: 'review_queued', review_attempts: 0, review_lease_token: null, review_lease_expires_at: null, updated_at: now() });
    state.events.push({ id: state.nextId++, workspace_id: workspace, task_id: id, role: 'System', message: 'Separate Claude QA pass queued. Owner approval will still be required.', created_at: now() });
    return true;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`UPDATE tasks SET status = 'review_queued', review_attempts = 0,
      review_lease_token = NULL, review_lease_expires_at = NULL, updated_at = now()
      WHERE id = $1 AND workspace_id = $2 AND status IN ('awaiting_review', 'review_failed')
      AND EXISTS (SELECT 1 FROM agent_messages WHERE task_id = $1 AND workspace_id = $2 AND kind = 'finding' AND demo = false AND jsonb_array_length(evidence_refs) > 0)
      RETURNING id`, [id, workspace]);
    if (!result.rowCount) { await client.query('ROLLBACK'); return false; }
    await client.query('INSERT INTO events (workspace_id, task_id, role, message) VALUES ($1, $2, $3, $4)',
      [workspace, id, 'System', 'Separate Claude QA pass queued. Owner approval will still be required.']);
    await client.query('COMMIT');
    return true;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function claimClaudeReview(pool, memory, workspace) {
  const token = randomUUID();
  let task;
  let finding;
  if (!pool) {
    const state = memory.get(workspace);
    const current = Date.now();
    for (const item of state.tasks) {
      if (item.status === 'review_running' && Date.parse(item.review_lease_expires_at) <= current && item.review_attempts >= maxAttempts) {
        item.status = 'review_failed'; item.review_lease_token = null; item.updated_at = now();
      }
    }
    task = state.tasks.find((item) => item.status === 'review_queued' ||
      (item.status === 'review_running' && Date.parse(item.review_lease_expires_at) <= current && item.review_attempts < maxAttempts));
    if (!task) return null;
    finding = [...state.messages].reverse().find((message) => message.task_id === task.id && message.kind === 'finding' && !message.demo);
    Object.assign(task, { status: 'review_running', review_lease_token: token,
      review_lease_expires_at: new Date(current + leaseMinutes * 60_000).toISOString(),
      review_attempts: (task.review_attempts || 0) + 1, updated_at: now() });
    state.events.push({ id: state.nextId++, workspace_id: workspace, task_id: task.id, role: 'Quality reviewer', message: 'Claimed the research draft for a separate source-checking pass.', created_at: now() });
  } else {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE tasks SET status = 'review_failed', review_lease_token = NULL, updated_at = now()
        WHERE workspace_id = $1 AND status = 'review_running' AND review_lease_expires_at < now() AND review_attempts >= $2`, [workspace, maxAttempts]);
      const result = await client.query(`WITH candidate AS (
        SELECT id FROM tasks WHERE workspace_id = $1 AND (status = 'review_queued' OR
          (status = 'review_running' AND review_lease_expires_at < now() AND review_attempts < $2))
        ORDER BY updated_at FOR UPDATE SKIP LOCKED LIMIT 1
      ) UPDATE tasks SET status = 'review_running', review_lease_token = $3,
        review_lease_expires_at = now() + interval '8 minutes', review_attempts = review_attempts + 1,
        updated_at = now() FROM candidate WHERE tasks.id = candidate.id
        RETURNING tasks.id, tasks.title, tasks.brief`, [workspace, maxAttempts, token]);
      task = result.rows[0];
      if (task) {
        const found = await client.query(`SELECT summary, evidence_refs FROM agent_messages
          WHERE workspace_id = $1 AND task_id = $2 AND kind = 'finding' AND demo = false ORDER BY id DESC LIMIT 1`, [workspace, task.id]);
        finding = found.rows[0];
        if (!finding) throw new Error('Review draft is missing');
        await client.query('INSERT INTO events (workspace_id, task_id, role, message) VALUES ($1, $2, $3, $4)',
          [workspace, task.id, 'Quality reviewer', 'Claimed the research draft for a separate source-checking pass.']);
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    if (!task) return null;
  }
  return { id: task.id, title: task.title, brief: task.brief, lease_token: token,
    draft: finding.summary, evidence_refs: finding.evidence_refs || [] };
}

function validLease(task, token) {
  return task?.status === 'review_running' && task.review_lease_token === token && Date.parse(task.review_lease_expires_at) > Date.now();
}

export async function completeClaudeReview(pool, memory, workspace, id, body) {
  validateClaudeResult(body);
  const verdict = reviewVerdict(body.summary);
  if (verdict === 'accept' && body.evidence_refs.length === 0) throw new Error('Accepted review must cite a checked source');
  const status = { accept: 'review_accepted', revise: 'review_revision', block: 'review_blocked' }[verdict];
  const usage = { ...body.usage, task_id: id, agent_id: 'Quality reviewer', provider: 'anthropic', model: body.model, request_id: body.request_id };
  if (!pool) {
    const state = memory.get(workspace);
    const task = state?.tasks.find((item) => item.id === id);
    if (!validLease(task, body.lease_token)) return false;
    await recordUsage(null, memory, workspace, usage);
    Object.assign(task, { status, review_lease_token: null, review_lease_expires_at: null, updated_at: now() });
    state.messages.push({ id: state.nextMessageId++, workspace_id: workspace, run_id: id, task_id: id,
      agent_id: 'Quality reviewer', recipient_id: verdict === 'accept' ? 'Owner' : 'Research worker',
      kind: 'review', summary: body.summary.trim(), artifact_refs: [], evidence_refs: body.evidence_refs,
      demo: false, created_at: now() });
    state.events.push({ id: state.nextId++, workspace_id: workspace, task_id: id, role: 'Quality reviewer',
      message: `Review verdict: ${verdict}. ${verdict === 'accept' ? 'Awaiting owner approval.' : 'Research is not approved.'}`, created_at: now() });
    return true;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query('SELECT status, review_lease_token, review_lease_expires_at FROM tasks WHERE id = $1 AND workspace_id = $2 FOR UPDATE', [id, workspace]);
    if (!validLease(locked.rows[0], body.lease_token)) { await client.query('ROLLBACK'); return false; }
    await recordUsage(client, memory, workspace, usage);
    await client.query(`INSERT INTO agent_messages (workspace_id, run_id, task_id, agent_id, recipient_id, kind, summary, evidence_refs, demo)
      VALUES ($1, $2, $2, 'Quality reviewer', $3, 'review', $4, $5::jsonb, false)`,
    [workspace, id, verdict === 'accept' ? 'Owner' : 'Research worker', body.summary.trim(), JSON.stringify(body.evidence_refs)]);
    await client.query(`UPDATE tasks SET status = $3, review_lease_token = NULL, review_lease_expires_at = NULL,
      updated_at = now() WHERE id = $1 AND workspace_id = $2`, [id, workspace, status]);
    await client.query('INSERT INTO events (workspace_id, task_id, role, message) VALUES ($1, $2, $3, $4)',
      [workspace, id, 'Quality reviewer', `Review verdict: ${verdict}. ${verdict === 'accept' ? 'Awaiting owner approval.' : 'Research is not approved.'}`]);
    await client.query('COMMIT');
    return true;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function failClaudeReview(pool, memory, workspace, id, token, code) {
  const message = code === 'limit_reached' ? 'Claude subscription limit reached during review.'
    : code === 'timeout' ? 'Reviewer timed out.' : 'Reviewer could not complete the source check.';
  if (!pool) {
    const state = memory.get(workspace);
    const task = state?.tasks.find((item) => item.id === id);
    if (!validLease(task, token)) return false;
    Object.assign(task, { status: 'review_failed', review_lease_token: null, review_lease_expires_at: null, updated_at: now() });
    state.events.push({ id: state.nextId++, workspace_id: workspace, task_id: id, role: 'System', message, created_at: now() });
    return true;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`UPDATE tasks SET status = 'review_failed', review_lease_token = NULL,
      review_lease_expires_at = NULL, updated_at = now() WHERE id = $1 AND workspace_id = $2
      AND status = 'review_running' AND review_lease_token = $3 AND review_lease_expires_at > now() RETURNING id`, [id, workspace, token]);
    if (!result.rowCount) { await client.query('ROLLBACK'); return false; }
    await client.query('INSERT INTO events (workspace_id, task_id, role, message) VALUES ($1, $2, $3, $4)', [workspace, id, 'System', message]);
    await client.query('COMMIT');
    return true;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function decideReview(pool, memory, workspace, id, decision, note) {
  if (!['approve', 'revise'].includes(decision)) throw new Error('Invalid owner decision');
  const text = typeof note === 'string' ? note.trim() : '';
  if (text.length > 1000 || (decision === 'revise' && text.length < 3)) throw new Error('Revision reason must be 3–1000 characters');
  const status = decision === 'approve' ? 'approved' : 'review_revision';
  const summary = decision === 'approve' ? `Owner approved the independently checked draft.${text ? ` Note: ${text}` : ''}` : `Owner requested revision: ${text}`;
  if (!pool) {
    const state = memory.get(workspace);
    const task = state?.tasks.find((item) => item.id === id && item.status === 'review_accepted');
    if (!task) return false;
    Object.assign(task, { status, updated_at: now() });
    state.messages.push({ id: state.nextMessageId++, workspace_id: workspace, run_id: randomUUID(), task_id: id,
      agent_id: 'Owner', recipient_id: decision === 'approve' ? 'Team' : 'Research worker', kind: 'decision',
      summary, artifact_refs: [], evidence_refs: [], demo: false, created_at: now() });
    state.events.push({ id: state.nextId++, workspace_id: workspace, task_id: id, role: 'Owner', message: summary, created_at: now() });
    return true;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`UPDATE tasks SET status = $3, updated_at = now()
      WHERE id = $1 AND workspace_id = $2 AND status = 'review_accepted' RETURNING id`, [id, workspace, status]);
    if (!result.rowCount) { await client.query('ROLLBACK'); return false; }
    await client.query(`INSERT INTO agent_messages (workspace_id, run_id, task_id, agent_id, recipient_id, kind, summary, demo)
      VALUES ($1, $2, $3, 'Owner', $4, 'decision', $5, false)`, [workspace, randomUUID(), id, decision === 'approve' ? 'Team' : 'Research worker', summary]);
    await client.query('INSERT INTO events (workspace_id, task_id, role, message) VALUES ($1, $2, $3, $4)', [workspace, id, 'Owner', summary]);
    await client.query('COMMIT');
    return true;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
