import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { recordUsage } from './usage-store.js';

const maxAttempts = 2;
const leaseMinutes = 8;

function now() { return new Date().toISOString(); }
const hashKey = (key) => createHash('sha256').update(key).digest('hex');

export async function pairClaudeWorker(pool, memory, workspace) {
  const key = randomBytes(32).toString('hex');
  const hash = hashKey(key);
  if (!pool) {
    const state = memory.get(workspace);
    state.claude_worker_key_hash = hash;
    state.claude_worker_seen_at = null;
  } else {
    await pool.query(`INSERT INTO claude_worker_presence (workspace_id, worker_key_hash, last_seen_at) VALUES ($1, $2, NULL)
      ON CONFLICT (workspace_id) DO UPDATE SET worker_key_hash = $2, last_seen_at = NULL`, [workspace, hash]);
  }
  return key;
}

export async function workspaceForWorkerKey(pool, memory, key) {
  if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) return null;
  const hash = hashKey(key);
  if (!pool) {
    for (const [workspace, state] of memory) if (state.claude_worker_key_hash === hash) return workspace;
    return null;
  }
  const result = await pool.query('SELECT workspace_id FROM claude_worker_presence WHERE worker_key_hash = $1', [hash]);
  return result.rows[0]?.workspace_id || null;
}

export async function queueClaudeTask(pool, memory, workspace, id) {
  if (!pool) {
    const state = memory.get(workspace);
    const task = state?.tasks.find((item) => item.id === id && ['queued', 'claude_failed'].includes(item.status));
    if (!task) return false;
    Object.assign(task, { status: 'claude_queued', claude_attempts: 0, claude_lease_token: null, claude_lease_expires_at: null, updated_at: now() });
    state.events.push({ id: state.nextId++, workspace_id: workspace, task_id: id, role: 'System', message: 'Queued for the owner-operated Claude research worker. Independent QA is still required.', created_at: now() });
    return true;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`UPDATE tasks SET status = 'claude_queued', claude_attempts = 0,
      claude_lease_token = NULL, claude_lease_expires_at = NULL, updated_at = now()
      WHERE id = $1 AND workspace_id = $2 AND status IN ('queued', 'claude_failed') RETURNING id`, [id, workspace]);
    if (!result.rowCount) { await client.query('ROLLBACK'); return false; }
    await client.query('INSERT INTO events (workspace_id, task_id, role, message) VALUES ($1, $2, $3, $4)',
      [workspace, id, 'System', 'Queued for the owner-operated Claude research worker. Independent QA is still required.']);
    await client.query('COMMIT');
    return true;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function heartbeatClaudeWorker(pool, memory, workspace) {
  if (!pool) { memory.get(workspace).claude_worker_seen_at = now(); return; }
  await pool.query(`INSERT INTO claude_worker_presence (workspace_id, last_seen_at) VALUES ($1, now())
    ON CONFLICT (workspace_id) DO UPDATE SET last_seen_at = now()`, [workspace]);
}

export async function claimClaudeTask(pool, memory, workspace) {
  const token = randomUUID();
  if (!pool) {
    const state = memory.get(workspace);
    const current = Date.now();
    for (const task of state.tasks) {
      if (task.status === 'claude_running' && Date.parse(task.claude_lease_expires_at) <= current && task.claude_attempts >= maxAttempts) {
        task.status = 'claude_failed'; task.updated_at = now();
      }
    }
    const task = state.tasks.find((item) => item.status === 'claude_queued' ||
      (item.status === 'claude_running' && Date.parse(item.claude_lease_expires_at) <= current && item.claude_attempts < maxAttempts));
    if (!task) return null;
    Object.assign(task, { status: 'claude_running', claude_lease_token: token,
      claude_lease_expires_at: new Date(current + leaseMinutes * 60_000).toISOString(),
      claude_attempts: (task.claude_attempts || 0) + 1, updated_at: now() });
    state.events.push({ id: state.nextId++, workspace_id: workspace, task_id: task.id, role: 'System', message: 'Claude worker claimed the task.', created_at: now() });
    return { id: task.id, title: task.title, brief: task.brief, lease_token: token };
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`UPDATE tasks SET status = 'claude_failed', claude_lease_token = NULL, updated_at = now()
      WHERE workspace_id = $1 AND status = 'claude_running' AND claude_lease_expires_at < now() AND claude_attempts >= $2`, [workspace, maxAttempts]);
    const result = await client.query(`WITH candidate AS (
      SELECT id FROM tasks WHERE workspace_id = $1 AND (status = 'claude_queued' OR
        (status = 'claude_running' AND claude_lease_expires_at < now() AND claude_attempts < $2))
      ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE tasks SET status = 'claude_running', claude_lease_token = $3,
      claude_lease_expires_at = now() + interval '8 minutes', claude_attempts = claude_attempts + 1,
      updated_at = now() FROM candidate WHERE tasks.id = candidate.id
      RETURNING tasks.id, tasks.title, tasks.brief`, [workspace, maxAttempts, token]);
    const task = result.rows[0];
    if (task) await client.query('INSERT INTO events (workspace_id, task_id, role, message) VALUES ($1, $2, $3, $4)',
      [workspace, task.id, 'System', 'Claude worker claimed the task.']);
    await client.query('COMMIT');
    return task ? { ...task, lease_token: token } : null;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

function validLease(task, token) {
  return task?.status === 'claude_running' && task.claude_lease_token === token && Date.parse(task.claude_lease_expires_at) > Date.now();
}

export function validateClaudeResult(body) {
  if (typeof body.lease_token !== 'string' || !/^[a-f0-9-]{36}$/.test(body.lease_token)) throw new Error('Invalid lease token');
  if (typeof body.summary !== 'string' || body.summary.trim().length < 20 || body.summary.length > 8000) throw new Error('Claude result must be 20–8000 characters');
  if (typeof body.model !== 'string' || body.model.length > 160) throw new Error('Invalid model');
  if (!Array.isArray(body.evidence_refs) || body.evidence_refs.length > 12 || body.evidence_refs.some((ref) => {
    try { return typeof ref !== 'string' || ref.length > 1000 || new URL(ref).protocol !== 'https:'; } catch { return true; }
  })) throw new Error('Invalid evidence links');
  return body;
}

export async function completeClaudeTask(pool, memory, workspace, id, body) {
  validateClaudeResult(body);
  const usage = { ...body.usage, task_id: id, agent_id: 'Research worker', provider: 'anthropic', model: body.model, request_id: body.request_id };
  if (!pool) {
    const state = memory.get(workspace);
    const task = state?.tasks.find((item) => item.id === id);
    if (!validLease(task, body.lease_token)) return false;
    await recordUsage(null, memory, workspace, usage);
    task.status = 'awaiting_review'; task.claude_lease_token = null; task.updated_at = now();
    state.messages.push({ id: state.nextMessageId++, workspace_id: workspace, run_id: id, task_id: id,
      agent_id: 'Research worker', recipient_id: 'Quality reviewer', kind: 'finding', summary: body.summary.trim(),
      artifact_refs: [], evidence_refs: body.evidence_refs, demo: false, created_at: now() });
    state.events.push({ id: state.nextId++, workspace_id: workspace, task_id: id, role: 'Research worker',
      message: 'Claude submitted a research draft; independent QA is pending.', created_at: now() });
    return true;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const locked = await client.query('SELECT status, claude_lease_token, claude_lease_expires_at FROM tasks WHERE id = $1 AND workspace_id = $2 FOR UPDATE', [id, workspace]);
    if (!validLease(locked.rows[0], body.lease_token)) { await client.query('ROLLBACK'); return false; }
    await recordUsage(client, memory, workspace, usage);
    await client.query(`INSERT INTO agent_messages (workspace_id, run_id, task_id, agent_id, recipient_id, kind, summary, evidence_refs, demo)
      VALUES ($1, $2, $2, 'Research worker', 'Quality reviewer', 'finding', $3, $4::jsonb, false)`,
    [workspace, id, body.summary.trim(), JSON.stringify(body.evidence_refs)]);
    await client.query(`UPDATE tasks SET status = 'awaiting_review', claude_lease_token = NULL, claude_lease_expires_at = NULL, updated_at = now() WHERE id = $1`, [id]);
    await client.query('INSERT INTO events (workspace_id, task_id, role, message) VALUES ($1, $2, $3, $4)',
      [workspace, id, 'Research worker', 'Claude submitted a research draft; independent QA is pending.']);
    await client.query('COMMIT');
    return true;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function failClaudeTask(pool, memory, workspace, id, leaseToken, code) {
  const reasons = {
    auth_required: 'Claude Code sign-in is required on the owner-operated worker.',
    limit_reached: 'Claude subscription usage limit reached; no automatic account switching.',
    timeout: 'Claude worker timed out before producing a draft.',
    invalid_output: 'Claude returned an invalid or oversized draft.',
    model_error: 'Claude could not complete this task.',
  };
  const message = reasons[code] || reasons.model_error;
  if (!pool) {
    const state = memory.get(workspace);
    const task = state?.tasks.find((item) => item.id === id);
    if (!validLease(task, leaseToken)) return false;
    task.status = 'claude_failed'; task.claude_lease_token = null; task.updated_at = now();
    state.events.push({ id: state.nextId++, workspace_id: workspace, task_id: id, role: 'System', message, created_at: now() });
    return true;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`UPDATE tasks SET status = 'claude_failed', claude_lease_token = NULL,
      claude_lease_expires_at = NULL, updated_at = now() WHERE id = $1 AND workspace_id = $2
      AND status = 'claude_running' AND claude_lease_token = $3 AND claude_lease_expires_at > now() RETURNING id`, [id, workspace, leaseToken]);
    if (!result.rowCount) { await client.query('ROLLBACK'); return false; }
    await client.query('INSERT INTO events (workspace_id, task_id, role, message) VALUES ($1, $2, $3, $4)', [workspace, id, 'System', message]);
    await client.query('COMMIT');
    return true;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
