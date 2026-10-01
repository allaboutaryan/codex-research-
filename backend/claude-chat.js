import { randomUUID } from 'node:crypto';
import { recordUsage } from './usage-store.js';
import { validateClaudeResult } from './claude-jobs.js';

export const defaultMission = 'Find a durable, useful software product by researching credible work from roughly the last ten years, identifying a real unmet need, then building and testing a reusable application. Preserve sources, decisions, limitations, and progress in the project repository. Treat research gaps as hypotheses until independently checked.';
const maxAttempts = 2;
const agents = ['CTO', 'Project manager', 'Team lead', 'Research worker', 'Quality reviewer'];
const stages = {
  team_plan: { agent: 'Project manager', recipient: 'Team lead', next: 'team_assign', status: 'lead_queued', kind: 'assignment' },
  team_assign: { agent: 'Team lead', recipient: 'Research worker', next: null, status: 'claude_queued', kind: 'assignment' },
  team_close: { agent: 'Project manager', recipient: 'CTO', next: 'cto_report', status: 'approved', kind: 'status' },
  cto_report: { agent: 'CTO', recipient: 'Owner', next: null, status: 'approved', kind: 'status' },
};

function stamp() { return new Date().toISOString(); }

export async function readProjectContext(pool, memory, workspace) {
  if (!pool) {
    const state = memory.get(workspace);
    return { mission: state.mission || defaultMission, notes: state.context_notes || '' };
  }
  const result = await pool.query('SELECT mission, context_notes FROM workspaces WHERE id = $1', [workspace]);
  return { mission: result.rows[0]?.mission || defaultMission, notes: result.rows[0]?.context_notes || '' };
}

export async function saveProjectContext(pool, memory, workspace, body) {
  const mission = String(body.mission || '').trim();
  const notes = String(body.notes || '').trim();
  if (mission.length < 20 || mission.length > 1500 || notes.length > 2000) throw new Error('Project goal must be 20–1500 characters and memory notes at most 2000 characters');
  if (!pool) {
    Object.assign(memory.get(workspace), { mission, context_notes: notes });
  } else {
    await pool.query('UPDATE workspaces SET mission = $2, context_notes = $3 WHERE id = $1', [workspace, mission, notes]);
  }
  return { mission, notes };
}

export async function queueClaudeChat(pool, memory, workspace, taskId, question, agentId = 'Research worker') {
  const text = typeof question === 'string' ? question.trim() : '';
  if (text.length < 3 || text.length > 2000) throw new Error('Question must be 3–2000 characters');
  if (!agents.includes(agentId)) throw new Error('Invalid chat recipient');
  const id = randomUUID();
  if (!pool) {
    const state = memory.get(workspace);
    if (!state.tasks.some((task) => task.id === taskId)) return null;
    const pending = state.chatJobs.filter((job) => job.status === 'queued' || job.status === 'running').length;
    if (pending >= 5) throw new Error('At most five Claude questions can be pending');
    state.messages.push({ id: state.nextMessageId++, workspace_id: workspace, run_id: id, task_id: taskId,
      agent_id: 'Owner', recipient_id: agentId, kind: 'question', summary: text,
      artifact_refs: [], evidence_refs: [], demo: false, created_at: stamp() });
    state.chatJobs.push({ id, task_id: taskId, question: text, agent_id: agentId, job_type: 'owner_chat', status: 'queued', attempts: 0, created_at: stamp() });
    return id;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM workspaces WHERE id = $1 FOR UPDATE', [workspace]);
    const task = await client.query('SELECT id FROM tasks WHERE id = $1 AND workspace_id = $2', [taskId, workspace]);
    if (!task.rowCount) { await client.query('ROLLBACK'); return null; }
    const pending = await client.query("SELECT count(*)::integer AS count FROM claude_chat_jobs WHERE workspace_id = $1 AND status IN ('queued', 'running')", [workspace]);
    if (pending.rows[0].count >= 5) throw new Error('At most five Claude questions can be pending');
    await client.query(`INSERT INTO agent_messages (workspace_id, run_id, task_id, agent_id, recipient_id, kind, summary, demo)
      VALUES ($1, $2, $3, 'Owner', $4, 'question', $5, false)`, [workspace, id, taskId, agentId, text]);
    await client.query('INSERT INTO claude_chat_jobs (id, workspace_id, task_id, question, agent_id, job_type) VALUES ($1, $2, $3, $4, $5, $6)', [id, workspace, taskId, text, agentId, 'owner_chat']);
    await client.query('COMMIT');
    return id;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function queueTeamWorkflow(pool, memory, workspace, taskId) {
  const id = randomUUID();
  const question = 'Scope this bounded research task and define acceptance criteria for the team lead. Do not conduct the research or imply that sources were checked.';
  if (!pool) {
    const state = memory.get(workspace);
    const task = state?.tasks.find((item) => item.id === taskId && ['queued', 'team_failed'].includes(item.status));
    if (!task) return false;
    Object.assign(task, { status: 'planning_queued', team_workflow: true, updated_at: stamp() });
    state.chatJobs.push({ id, task_id: taskId, question, agent_id: 'Project manager', job_type: 'team_plan', status: 'queued', attempts: 0, created_at: stamp() });
    state.events.push({ id: state.nextId++, workspace_id: workspace, task_id: taskId, role: 'System', message: 'Real team workflow queued: PM → lead → research → QA → owner → PM → CTO.', created_at: stamp() });
    return true;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`UPDATE tasks SET status = 'planning_queued', team_workflow = true, updated_at = now()
      WHERE id = $1 AND workspace_id = $2 AND status IN ('queued', 'team_failed') RETURNING id`, [taskId, workspace]);
    if (!result.rowCount) { await client.query('ROLLBACK'); return false; }
    await client.query(`INSERT INTO claude_chat_jobs (id, workspace_id, task_id, question, agent_id, job_type)
      VALUES ($1, $2, $3, $4, 'Project manager', 'team_plan')`, [id, workspace, taskId, question]);
    await client.query('INSERT INTO events (workspace_id, task_id, role, message) VALUES ($1, $2, $3, $4)',
      [workspace, taskId, 'System', 'Real team workflow queued: PM → lead → research → QA → owner → PM → CTO.']);
    await client.query('COMMIT');
    return true;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

function trimMessage(message) {
  return { agent: message.agent_id, kind: message.kind, text: String(message.summary || '').slice(0, 700),
    task_id: message.task_id, created_at: message.created_at };
}

export async function buildChatContext(pool, memory, workspace, taskId, currentJobId) {
  const project = await readProjectContext(pool, memory, workspace);
  let task;
  let messages;
  if (!pool) {
    const state = memory.get(workspace);
    task = state.tasks.find((item) => item.id === taskId);
    messages = state.messages.filter((item) => !item.demo && item.run_id !== currentJobId).slice(-100).reverse();
  } else {
    const [taskResult, history] = await Promise.all([
      pool.query('SELECT id, title, brief, status FROM tasks WHERE id = $1 AND workspace_id = $2', [taskId, workspace]),
      pool.query(`SELECT task_id, agent_id, kind, summary, created_at FROM agent_messages
        WHERE workspace_id = $1 AND demo = false AND run_id <> $2 ORDER BY id DESC LIMIT 100`, [workspace, currentJobId]),
    ]);
    task = taskResult.rows[0];
    messages = history.rows;
  }
  if (!task) throw new Error('Task is unavailable');
  const onTask = messages.filter((item) => item.task_id === taskId).slice(0, 12).reverse().map(trimMessage);
  const acrossTasks = messages.filter((item) => item.task_id !== taskId && item.agent_id !== 'Owner').slice(0, 5).reverse().map(trimMessage);
  return {
    project_goal: project.mission,
    owner_memory_notes: project.notes,
    task: { id: task.id, title: task.title, brief: task.brief, status: task.status },
    recent_task_history: onTask,
    recent_other_work: acrossTasks,
    context_policy: 'History is selected and bounded for token efficiency; the full audit trail remains in Agent chats. Prior findings are unverified unless explicitly reviewed.',
  };
}

export async function claimClaudeChat(pool, memory, workspace) {
  const token = randomUUID();
  let job;
  if (!pool) {
    const state = memory.get(workspace);
    const current = Date.now();
    for (const item of state.chatJobs) if (item.status === 'running' && Date.parse(item.lease_expires_at) <= current && item.attempts >= maxAttempts) {
      item.status = 'failed';
      if (['team_plan', 'team_assign'].includes(item.job_type)) {
        const task = state.tasks.find((entry) => entry.id === item.task_id);
        if (task) { task.status = 'team_failed'; task.updated_at = stamp(); }
      }
    }
    job = state.chatJobs.find((item) => item.status === 'queued' ||
      (item.status === 'running' && Date.parse(item.lease_expires_at) <= current && item.attempts < maxAttempts));
    if (!job) return null;
    Object.assign(job, { status: 'running', lease_token: token, lease_expires_at: new Date(current + 8 * 60_000).toISOString(), attempts: job.attempts + 1 });
  } else {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`WITH expired AS (UPDATE claude_chat_jobs SET status = 'failed', lease_token = NULL
        WHERE workspace_id = $1 AND status = 'running' AND lease_expires_at < now() AND attempts >= $2 RETURNING task_id, job_type)
        UPDATE tasks SET status = 'team_failed', updated_at = now() WHERE id IN
        (SELECT task_id FROM expired WHERE job_type IN ('team_plan', 'team_assign'))`, [workspace, maxAttempts]);
      const result = await client.query(`WITH candidate AS (
        SELECT id FROM claude_chat_jobs WHERE workspace_id = $1 AND (status = 'queued' OR
          (status = 'running' AND lease_expires_at < now() AND attempts < $2))
        ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
      ) UPDATE claude_chat_jobs SET status = 'running', lease_token = $3,
        lease_expires_at = now() + interval '8 minutes', attempts = attempts + 1
        FROM candidate WHERE claude_chat_jobs.id = candidate.id
        RETURNING claude_chat_jobs.id, claude_chat_jobs.task_id, claude_chat_jobs.question, claude_chat_jobs.agent_id, claude_chat_jobs.job_type`, [workspace, maxAttempts, token]);
      job = result.rows[0];
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    if (!job) return null;
  }
  return { id: job.id, task_id: job.task_id, question: job.question, agent_id: job.agent_id || 'Research worker', job_type: job.job_type || 'owner_chat', lease_token: token,
    context: await buildChatContext(pool, memory, workspace, job.task_id, job.id) };
}

function validLease(job, token) {
  return job?.status === 'running' && job.lease_token === token && Date.parse(job.lease_expires_at) > Date.now();
}

export async function completeClaudeChat(pool, memory, workspace, id, body) {
  validateClaudeResult(body);
  const usage = { ...body.usage, task_id: null, agent_id: null, provider: 'anthropic', model: body.model, request_id: body.request_id };
  if (!pool) {
    const state = memory.get(workspace);
    const job = state.chatJobs.find((item) => item.id === id);
    if (!validLease(job, body.lease_token)) return false;
    usage.task_id = job.task_id;
    usage.agent_id = job.agent_id || 'Research worker';
    const stage = stages[job.job_type];
    await recordUsage(null, memory, workspace, usage);
    job.status = 'complete'; job.lease_token = null;
    state.messages.push({ id: state.nextMessageId++, workspace_id: workspace, run_id: id, task_id: job.task_id,
      agent_id: usage.agent_id, recipient_id: stage?.recipient || 'Owner', kind: stage?.kind || 'answer', summary: body.summary.trim(),
      artifact_refs: [], evidence_refs: body.evidence_refs, demo: false, created_at: stamp() });
    if (stage) {
      const task = state.tasks.find((item) => item.id === job.task_id);
      task.status = stage.status; task.updated_at = stamp();
      state.events.push({ id: state.nextId++, workspace_id: workspace, task_id: job.task_id, role: usage.agent_id,
        message: `${usage.agent_id} completed the ${job.job_type.replaceAll('_', ' ')} handoff.`, created_at: stamp() });
      if (stage.next) state.chatJobs.push(nextStageJob(stage.next, job.task_id));
    }
    return true;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT task_id, agent_id, job_type, status, lease_token, lease_expires_at FROM claude_chat_jobs WHERE id = $1 AND workspace_id = $2 FOR UPDATE', [id, workspace]);
    const job = result.rows[0];
    if (!validLease(job, body.lease_token)) { await client.query('ROLLBACK'); return false; }
    usage.task_id = job.task_id;
    usage.agent_id = job.agent_id || 'Research worker';
    const stage = stages[job.job_type];
    await recordUsage(client, memory, workspace, usage);
    await client.query(`INSERT INTO agent_messages (workspace_id, run_id, task_id, agent_id, recipient_id, kind, summary, evidence_refs, demo)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, false)`,
    [workspace, id, job.task_id, usage.agent_id, stage?.recipient || 'Owner', stage?.kind || 'answer', body.summary.trim(), JSON.stringify(body.evidence_refs)]);
    if (stage) {
      await client.query('UPDATE tasks SET status = $2, updated_at = now() WHERE id = $1', [job.task_id, stage.status]);
      await client.query('INSERT INTO events (workspace_id, task_id, role, message) VALUES ($1, $2, $3, $4)',
        [workspace, job.task_id, usage.agent_id, `${usage.agent_id} completed the ${job.job_type.replaceAll('_', ' ')} handoff.`]);
      if (stage.next) {
        const next = nextStageJob(stage.next, job.task_id);
        await client.query(`INSERT INTO claude_chat_jobs (id, workspace_id, task_id, question, agent_id, job_type)
          VALUES ($1, $2, $3, $4, $5, $6)`, [next.id, workspace, job.task_id, next.question, next.agent_id, next.job_type]);
      }
    }
    await client.query("UPDATE claude_chat_jobs SET status = 'complete', lease_token = NULL, lease_expires_at = NULL WHERE id = $1", [id]);
    await client.query('COMMIT');
    return true;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

function nextStageJob(type, taskId) {
  const prompts = {
    team_assign: 'Read the PM handoff, turn it into one precise research assignment with source requirements and a QA gate. Do not conduct the research.',
    team_close: 'The owner approved the reviewed draft. Summarize the outcome, remaining limitations, and next decision for the CTO. Do not claim broader validation.',
    cto_report: 'Give the owner a concise executive status: what was actually checked and approved, evidence limitations, remaining risks, and the next small decision. Do not authorize building automatically.',
  };
  return { id: randomUUID(), task_id: taskId, question: prompts[type], agent_id: stages[type].agent,
    job_type: type, status: 'queued', attempts: 0, created_at: stamp() };
}

export async function failClaudeChat(pool, memory, workspace, id, token, code) {
  const reason = code === 'limit_reached' ? 'Claude subscription limit reached. Retry after it resets.'
    : code === 'timeout' ? 'Claude timed out while answering.' : 'Claude could not answer this question.';
  if (!pool) {
    const state = memory.get(workspace);
    const job = state.chatJobs.find((item) => item.id === id);
    if (!validLease(job, token)) return false;
    job.status = 'failed'; job.lease_token = null;
    if (['team_plan', 'team_assign'].includes(job.job_type)) {
      const task = state.tasks.find((item) => item.id === job.task_id);
      task.status = 'team_failed'; task.updated_at = stamp();
    }
    state.messages.push({ id: state.nextMessageId++, workspace_id: workspace, run_id: id, task_id: job.task_id,
      agent_id: 'System', recipient_id: 'Owner', kind: 'blocker', summary: reason,
      artifact_refs: [], evidence_refs: [], demo: false, created_at: stamp() });
    return true;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(`UPDATE claude_chat_jobs SET status = 'failed', lease_token = NULL, lease_expires_at = NULL
      WHERE id = $1 AND workspace_id = $2 AND status = 'running' AND lease_token = $3 AND lease_expires_at > now() RETURNING task_id, job_type`, [id, workspace, token]);
    if (!result.rowCount) { await client.query('ROLLBACK'); return false; }
    if (['team_plan', 'team_assign'].includes(result.rows[0].job_type)) await client.query("UPDATE tasks SET status = 'team_failed', updated_at = now() WHERE id = $1", [result.rows[0].task_id]);
    await client.query(`INSERT INTO agent_messages (workspace_id, run_id, task_id, agent_id, recipient_id, kind, summary, demo)
      VALUES ($1, $2, $3, 'System', 'Owner', 'blocker', $4, false)`, [workspace, id, result.rows[0].task_id, reason]);
    await client.query('COMMIT');
    return true;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
