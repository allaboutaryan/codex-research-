import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { readUsage } from './usage-store.js';
import { claimClaudeTask, completeClaudeTask, failClaudeTask, heartbeatClaudeWorker, pairClaudeWorker, queueClaudeTask, workspaceForWorkerKey } from './claude-jobs.js';
import { buildChatContext, claimClaudeChat, completeClaudeChat, defaultMission, failClaudeChat, queueClaudeChat, readProjectContext, saveProjectContext } from './claude-chat.js';

const port = Number(process.env.PORT ?? 8787);
const pool = process.env.DATABASE_URL ? new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 }) : null;
const memory = new Map();
const phases = [
  { agent: 'Project manager', recipient: 'Team lead', kind: 'assignment', event: 'Scoped the assignment and set a review gate.', summary: (task) => `Demo assignment: coordinate a sample work packet for “${task.title}”. This run performs no research.` },
  { agent: 'Team lead', recipient: 'Research worker', kind: 'assignment', event: 'Assigned the task to the research worker.', summary: () => 'Demo handoff: prepare a sample work packet and label every item as simulated. Do not search external sources.' },
  { agent: 'Research worker', recipient: 'Quality reviewer', kind: 'handoff', event: 'Submitted a sample work packet for review.', summary: () => 'Sample packet submitted for workflow review. No papers were read, sources gathered, or findings produced.' },
  { agent: 'Quality reviewer', recipient: 'Research worker', kind: 'review', event: 'Requested one revision in this workflow demo.', summary: () => 'Revision requested: make the demo-only status explicit so no sample text is mistaken for verified research.' },
  { agent: 'Research worker', recipient: 'Quality reviewer', kind: 'handoff', event: 'Returned a revised sample work packet.', summary: () => 'Revision submitted: the packet is now marked as simulated and contains no research claims.' },
  { agent: 'Quality reviewer', recipient: 'Project manager', kind: 'review', event: 'Confirmed the sample review handoff.', summary: () => 'Accepted the workflow demonstration only. No evidence check was possible because there are no research sources.' },
  { agent: 'Project manager', recipient: 'CTO', kind: 'decision', event: 'Closed the workflow walkthrough. No research was performed.', summary: () => 'Closed the demo task after the sample QA handoff. Research output: none; model calls: zero.' },
  { agent: 'CTO', recipient: 'Owner', kind: 'status', event: 'Reported the completed walkthrough to the owner.', summary: () => 'Demo walkthrough complete. The team chat shown here is scripted; real agents and daily reports are not yet active.' },
];

function keyFrom(request) {
  const key = request.headers['x-workspace-key'];
  if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) return null;
  return createHash('sha256').update(key).digest('hex');
}

function send(response, status, data) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, HEAD, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, x-workspace-key',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(data));
}

async function bodyOf(request) {
  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 16_384) throw new Error('Request is too large');
  }
  return raw ? JSON.parse(raw) : {};
}

async function init() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS workspaces (
      id text PRIMARY KEY,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS mission text NOT NULL DEFAULT '${defaultMission.replaceAll("'", "''")}';
    ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS context_notes text NOT NULL DEFAULT '';
    CREATE TABLE IF NOT EXISTS tasks (
      id text PRIMARY KEY,
      workspace_id text NOT NULL REFERENCES workspaces(id),
      title text NOT NULL,
      brief text NOT NULL DEFAULT '',
      status text NOT NULL DEFAULT 'queued',
      step integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS claude_attempts integer NOT NULL DEFAULT 0;
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS claude_lease_token text;
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS claude_lease_expires_at timestamptz;
    CREATE TABLE IF NOT EXISTS events (
      id bigserial PRIMARY KEY,
      workspace_id text NOT NULL REFERENCES workspaces(id),
      task_id text REFERENCES tasks(id),
      role text NOT NULL,
      message text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS agent_messages (
      id bigserial PRIMARY KEY,
      workspace_id text NOT NULL REFERENCES workspaces(id),
      run_id text NOT NULL,
      task_id text NOT NULL REFERENCES tasks(id),
      agent_id text NOT NULL,
      recipient_id text NOT NULL,
      kind text NOT NULL,
      summary text NOT NULL,
      artifact_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
      evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
      demo boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS usage_events (
      id bigserial PRIMARY KEY,
      workspace_id text NOT NULL REFERENCES workspaces(id),
      task_id text NOT NULL REFERENCES tasks(id),
      agent_id text NOT NULL,
      provider text NOT NULL,
      model text NOT NULL DEFAULT '',
      request_id text NOT NULL,
      input_tokens integer NOT NULL CHECK (input_tokens >= 0),
      output_tokens integer NOT NULL CHECK (output_tokens >= 0),
      cached_input_tokens integer NOT NULL DEFAULT 0 CHECK (cached_input_tokens >= 0),
      cache_write_tokens integer NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0),
      reasoning_output_tokens integer NOT NULL DEFAULT 0 CHECK (reasoning_output_tokens >= 0),
      cost_usd numeric(12,6),
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (workspace_id, provider, request_id)
    );
    CREATE TABLE IF NOT EXISTS claude_worker_presence (
      workspace_id text PRIMARY KEY REFERENCES workspaces(id),
      last_seen_at timestamptz,
      worker_key_hash text UNIQUE
    );
    ALTER TABLE claude_worker_presence ALTER COLUMN last_seen_at DROP NOT NULL;
    ALTER TABLE claude_worker_presence ADD COLUMN IF NOT EXISTS worker_key_hash text;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_claude_worker_key_hash ON claude_worker_presence(worker_key_hash);
    CREATE TABLE IF NOT EXISTS claude_chat_jobs (
      id text PRIMARY KEY,
      workspace_id text NOT NULL REFERENCES workspaces(id),
      task_id text NOT NULL REFERENCES tasks(id),
      question text NOT NULL,
      status text NOT NULL DEFAULT 'queued',
      attempts integer NOT NULL DEFAULT 0,
      lease_token text,
      lease_expires_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS idx_claude_chat_workspace_created ON claude_chat_jobs(workspace_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tasks_workspace_created ON tasks(workspace_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_events_workspace_id ON events(workspace_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_messages_workspace_id ON agent_messages(workspace_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_messages_task_id ON agent_messages(task_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_usage_events_workspace_id ON usage_events(workspace_id, id DESC);
  `);
}

async function ensureWorkspace(workspace) {
  if (!pool) {
    if (!memory.has(workspace)) memory.set(workspace, { tasks: [], events: [], messages: [], chatJobs: [], usage: [], mission: defaultMission, context_notes: '', nextId: 1, nextMessageId: 1 });
    return;
  }
  await pool.query('INSERT INTO workspaces (id) VALUES ($1) ON CONFLICT DO NOTHING', [workspace]);
}

async function readState(workspace) {
  await ensureWorkspace(workspace);
  if (!pool) {
    const state = memory.get(workspace);
    return { tasks: [...state.tasks].reverse().map(({ claude_lease_token, claude_lease_expires_at, ...task }) => task), events: [...state.events].reverse().slice(0, 50), messages: [...state.messages].reverse().slice(0, 200), chatJobs: [...state.chatJobs].reverse().slice(0, 30).map(({ lease_token, lease_expires_at, question, ...job }) => job) };
  }
  const [tasks, events, messages, chatJobs] = await Promise.all([
    pool.query('SELECT id, workspace_id, title, brief, status, step, claude_attempts, created_at, updated_at FROM tasks WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 30', [workspace]),
    pool.query('SELECT * FROM events WHERE workspace_id = $1 ORDER BY id DESC LIMIT 50', [workspace]),
    pool.query('SELECT * FROM agent_messages WHERE workspace_id = $1 ORDER BY id DESC LIMIT 200', [workspace]),
    pool.query('SELECT id, task_id, status, created_at FROM claude_chat_jobs WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 30', [workspace]),
  ]);
  return { tasks: tasks.rows, events: events.rows, messages: messages.rows, chatJobs: chatJobs.rows };
}

async function createTask(workspace, title, brief) {
  await ensureWorkspace(workspace);
  const id = randomUUID();
  if (!pool) {
    const state = memory.get(workspace);
    if (state.tasks.length >= 20) throw new Error('This demo workspace is limited to 20 tasks');
    state.tasks.push({ id, workspace_id: workspace, title, brief, status: 'queued', step: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    state.events.push({ id: state.nextId++, workspace_id: workspace, task_id: id, role: 'System', message: 'Task created. Choose a demo walkthrough or Claude research run.', created_at: new Date().toISOString() });
    return id;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const count = await client.query('SELECT count(*)::integer AS count FROM tasks WHERE workspace_id = $1', [workspace]);
    if (count.rows[0].count >= 20) throw new Error('This demo workspace is limited to 20 tasks');
    await client.query('INSERT INTO tasks (id, workspace_id, title, brief) VALUES ($1, $2, $3, $4)', [id, workspace, title, brief]);
    await client.query('INSERT INTO events (workspace_id, task_id, role, message) VALUES ($1, $2, $3, $4)', [workspace, id, 'System', 'Task created. Choose a demo walkthrough or Claude research run.']);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return id;
}

async function startTask(workspace, id) {
  if (!pool) {
    const state = memory.get(workspace);
    const task = state?.tasks.find((item) => item.id === id && item.status === 'queued');
    if (!task) return false;
    task.status = 'running';
    task.updated_at = new Date().toISOString();
    state.events.push({ id: state.nextId++, workspace_id: workspace, task_id: id, role: 'System', message: 'Workflow demo started. AI usage remains zero.', created_at: new Date().toISOString() });
    return true;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query("UPDATE tasks SET status = 'running', updated_at = now() WHERE id = $1 AND workspace_id = $2 AND status = 'queued' RETURNING id", [id, workspace]);
    if (!result.rowCount) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query('INSERT INTO events (workspace_id, task_id, role, message) VALUES ($1, $2, $3, $4)', [workspace, id, 'System', 'Workflow demo started. AI usage remains zero.']);
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function advance() {
  if (!pool) {
    for (const [workspace, state] of memory) {
      for (const task of state.tasks) {
        if (task.status !== 'running' || Date.now() - new Date(task.updated_at).getTime() < 1600) continue;
        const phase = phases[task.step];
        if (!phase) {
          task.status = 'complete';
          continue;
        }
        const createdAt = new Date().toISOString();
        state.events.push({ id: state.nextId++, workspace_id: workspace, task_id: task.id, role: phase.agent, message: phase.event, created_at: createdAt });
        state.messages.push({ id: state.nextMessageId++, workspace_id: workspace, run_id: task.id, task_id: task.id, agent_id: phase.agent, recipient_id: phase.recipient, kind: phase.kind, summary: phase.summary(task), artifact_refs: [], evidence_refs: [], demo: true, created_at: createdAt });
        task.step += 1;
        task.status = task.step >= phases.length ? 'complete' : 'running';
        task.updated_at = new Date().toISOString();
      }
    }
    return;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query("SELECT id, workspace_id, title, step FROM tasks WHERE status = 'running' AND updated_at < now() - interval '1.6 seconds' ORDER BY updated_at LIMIT 1 FOR UPDATE SKIP LOCKED");
    const task = result.rows[0];
    if (!task) {
      await client.query('COMMIT');
      return;
    }
    const phase = phases[task.step];
    if (!phase) {
      await client.query("UPDATE tasks SET status = 'complete', updated_at = now() WHERE id = $1", [task.id]);
      await client.query('COMMIT');
      return;
    }
    const nextStep = task.step + 1;
    await client.query('UPDATE tasks SET step = $1, status = $2, updated_at = now() WHERE id = $3', [nextStep, nextStep >= phases.length ? 'complete' : 'running', task.id]);
    await client.query('INSERT INTO events (workspace_id, task_id, role, message) VALUES ($1, $2, $3, $4)', [task.workspace_id, task.id, phase.agent, phase.event]);
    await client.query('INSERT INTO agent_messages (workspace_id, run_id, task_id, agent_id, recipient_id, kind, summary) VALUES ($1, $2, $3, $4, $5, $6, $7)', [task.workspace_id, task.id, task.id, phase.agent, phase.recipient, phase.kind, phase.summary(task)]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Worker step failed:', error.message);
  } finally {
    client.release();
  }
}

const server = http.createServer(async (request, response) => {
  if (request.method === 'OPTIONS') return send(response, 204, {});
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/health') return send(response, 200, { ok: true, database: pool ? 'postgres' : 'memory', mode: 'demo' });
  try {
    const workerCall = url.pathname.startsWith('/api/worker/claude/') && url.pathname !== '/api/worker/claude/pair';
    const workspace = workerCall
      ? await workspaceForWorkerKey(pool, memory, request.headers['x-worker-key'])
      : keyFrom(request);
    if (!workspace) return send(response, 401, { error: workerCall ? 'A valid worker key is required' : 'A workspace key is required' });
    if (request.method === 'GET' && url.pathname === '/api/state') {
      const state = await readState(workspace);
      return send(response, 200, { ...state, mode: state.chatJobs.length || state.tasks.some((task) => task.status.startsWith('claude_') || task.status === 'awaiting_review') ? 'claude_pilot' : 'demo', database: pool ? 'postgres' : 'memory', maxTasks: 20 });
    }
    if (request.method === 'GET' && url.pathname === '/api/usage') {
      await ensureWorkspace(workspace);
      return send(response, 200, await readUsage(pool, memory, workspace));
    }
    if (request.method === 'GET' && url.pathname === '/api/context') {
      await ensureWorkspace(workspace);
      return send(response, 200, await readProjectContext(pool, memory, workspace));
    }
    if (request.method === 'POST' && url.pathname === '/api/context') {
      await ensureWorkspace(workspace);
      return send(response, 200, await saveProjectContext(pool, memory, workspace, await bodyOf(request)));
    }
    if (request.method === 'POST' && url.pathname === '/api/chat') {
      await ensureWorkspace(workspace);
      const body = await bodyOf(request);
      if (typeof body.task_id !== 'string' || !/^[a-f0-9-]{36}$/.test(body.task_id)) return send(response, 400, { error: 'A task is required for Claude chat' });
      const id = await queueClaudeChat(pool, memory, workspace, body.task_id, body.message);
      return send(response, id ? 201 : 404, id ? { id } : { error: 'Task not found' });
    }
    if (request.method === 'POST' && url.pathname === '/api/tasks') {
      const body = await bodyOf(request);
      const title = String(body.title || '').trim().slice(0, 120);
      const brief = String(body.brief || '').trim().slice(0, 1000);
      if (title.length < 3) return send(response, 400, { error: 'Task title must have at least 3 characters' });
      const id = await createTask(workspace, title, brief);
      return send(response, 201, { id });
    }
    if (request.method === 'POST' && url.pathname === '/api/worker/claude/pair') {
      await ensureWorkspace(workspace);
      return send(response, 200, { worker_key: await pairClaudeWorker(pool, memory, workspace) });
    }
    if (request.method === 'POST' && url.pathname === '/api/worker/claude/heartbeat') {
      await ensureWorkspace(workspace);
      await heartbeatClaudeWorker(pool, memory, workspace);
      return send(response, 200, { ok: true });
    }
    if (request.method === 'POST' && url.pathname === '/api/worker/claude/claim') {
      await ensureWorkspace(workspace);
      const task = await claimClaudeTask(pool, memory, workspace);
      return send(response, 200, { task: task ? { ...task, context: await buildChatContext(pool, memory, workspace, task.id, '') } : null });
    }
    if (request.method === 'POST' && url.pathname === '/api/worker/claude/claim-chat') {
      await ensureWorkspace(workspace);
      return send(response, 200, { job: await claimClaudeChat(pool, memory, workspace) });
    }
    const claudeTask = url.pathname.match(/^\/api\/tasks\/([a-f0-9-]{36})\/start-claude$/);
    if (request.method === 'POST' && claudeTask) {
      await ensureWorkspace(workspace);
      const queued = await queueClaudeTask(pool, memory, workspace, claudeTask[1]);
      return send(response, queued ? 200 : 409, queued ? { ok: true } : { error: 'Task is unavailable for Claude' });
    }
    const claudeResult = url.pathname.match(/^\/api\/worker\/claude\/([a-f0-9-]{36})\/(complete|fail)$/);
    if (request.method === 'POST' && claudeResult) {
      await ensureWorkspace(workspace);
      const body = await bodyOf(request);
      const saved = claudeResult[2] === 'complete'
        ? await completeClaudeTask(pool, memory, workspace, claudeResult[1], body)
        : await failClaudeTask(pool, memory, workspace, claudeResult[1], body.lease_token, body.code);
      return send(response, saved ? 200 : 409, saved ? { ok: true } : { error: 'The Claude lease is no longer active' });
    }
    const chatResult = url.pathname.match(/^\/api\/worker\/claude\/chat\/([a-f0-9-]{36})\/(complete|fail)$/);
    if (request.method === 'POST' && chatResult) {
      await ensureWorkspace(workspace);
      const body = await bodyOf(request);
      const saved = chatResult[2] === 'complete'
        ? await completeClaudeChat(pool, memory, workspace, chatResult[1], body)
        : await failClaudeChat(pool, memory, workspace, chatResult[1], body.lease_token, body.code);
      return send(response, saved ? 200 : 409, saved ? { ok: true } : { error: 'The Claude chat lease is no longer active' });
    }
    const match = url.pathname.match(/^\/api\/tasks\/([a-f0-9-]{36})\/start$/);
    if (request.method === 'POST' && match) {
      await ensureWorkspace(workspace);
      const started = await startTask(workspace, match[1]);
      return send(response, started ? 200 : 409, started ? { ok: true } : { error: 'Task is unavailable or already started' });
    }
    return send(response, 404, { error: 'Not found' });
  } catch (error) {
    const badRequest = error instanceof SyntaxError || /too large|limited to 20|Invalid |must be|does not match|is required|exceeds its total|at most five|Question must|Project goal must/.test(error.message);
    if (!badRequest) console.error('Request failed:', error);
    return send(response, badRequest ? 400 : 500, { error: badRequest ? error.message : 'Service unavailable' });
  }
});

await init();
server.listen(port, '0.0.0.0', () => console.log(`Northstar Lab API listening on ${server.address().port}`));
setInterval(() => advance().catch((error) => console.error('Worker failed:', error)), 750).unref();
