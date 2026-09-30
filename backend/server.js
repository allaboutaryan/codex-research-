import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { readUsage } from './usage-store.js';

const port = Number(process.env.PORT || 8787);
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
    CREATE INDEX IF NOT EXISTS idx_tasks_workspace_created ON tasks(workspace_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_events_workspace_id ON events(workspace_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_messages_workspace_id ON agent_messages(workspace_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_messages_task_id ON agent_messages(task_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_usage_events_workspace_id ON usage_events(workspace_id, id DESC);
  `);
}

async function ensureWorkspace(workspace) {
  if (!pool) {
    if (!memory.has(workspace)) memory.set(workspace, { tasks: [], events: [], messages: [], usage: [], nextId: 1, nextMessageId: 1 });
    return;
  }
  await pool.query('INSERT INTO workspaces (id) VALUES ($1) ON CONFLICT DO NOTHING', [workspace]);
}

async function readState(workspace) {
  await ensureWorkspace(workspace);
  if (!pool) {
    const state = memory.get(workspace);
    return { tasks: [...state.tasks].reverse(), events: [...state.events].reverse().slice(0, 50), messages: [...state.messages].reverse().slice(0, 200) };
  }
  const [tasks, events, messages] = await Promise.all([
    pool.query('SELECT * FROM tasks WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 30', [workspace]),
    pool.query('SELECT * FROM events WHERE workspace_id = $1 ORDER BY id DESC LIMIT 50', [workspace]),
    pool.query('SELECT * FROM agent_messages WHERE workspace_id = $1 ORDER BY id DESC LIMIT 200', [workspace]),
  ]);
  return { tasks: tasks.rows, events: events.rows, messages: messages.rows };
}

async function createTask(workspace, title, brief) {
  await ensureWorkspace(workspace);
  const id = randomUUID();
  if (!pool) {
    const state = memory.get(workspace);
    if (state.tasks.length >= 20) throw new Error('This demo workspace is limited to 20 tasks');
    state.tasks.push({ id, workspace_id: workspace, title, brief, status: 'queued', step: 0, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    state.events.push({ id: state.nextId++, workspace_id: workspace, task_id: id, role: 'System', message: 'Task queued for a workflow demo.', created_at: new Date().toISOString() });
    return id;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const count = await client.query('SELECT count(*)::integer AS count FROM tasks WHERE workspace_id = $1', [workspace]);
    if (count.rows[0].count >= 20) throw new Error('This demo workspace is limited to 20 tasks');
    await client.query('INSERT INTO tasks (id, workspace_id, title, brief) VALUES ($1, $2, $3, $4)', [id, workspace, title, brief]);
    await client.query('INSERT INTO events (workspace_id, task_id, role, message) VALUES ($1, $2, $3, $4)', [workspace, id, 'System', 'Task queued for a workflow demo.']);
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
  const workspace = keyFrom(request);
  if (!workspace) return send(response, 401, { error: 'A workspace key is required' });
  try {
    if (request.method === 'GET' && url.pathname === '/api/state') {
      const state = await readState(workspace);
      return send(response, 200, { ...state, mode: 'demo', database: pool ? 'postgres' : 'memory', modelCalls: 0, inputTokens: 0, outputTokens: 0, maxTasks: 20 });
    }
    if (request.method === 'GET' && url.pathname === '/api/usage') {
      await ensureWorkspace(workspace);
      return send(response, 200, await readUsage(pool, memory, workspace));
    }
    if (request.method === 'POST' && url.pathname === '/api/tasks') {
      const body = await bodyOf(request);
      const title = String(body.title || '').trim().slice(0, 120);
      const brief = String(body.brief || '').trim().slice(0, 1000);
      if (title.length < 3) return send(response, 400, { error: 'Task title must have at least 3 characters' });
      const id = await createTask(workspace, title, brief);
      return send(response, 201, { id });
    }
    const match = url.pathname.match(/^\/api\/tasks\/([a-f0-9-]{36})\/start$/);
    if (request.method === 'POST' && match) {
      await ensureWorkspace(workspace);
      const started = await startTask(workspace, match[1]);
      return send(response, started ? 200 : 409, started ? { ok: true } : { error: 'Task is unavailable or already started' });
    }
    return send(response, 404, { error: 'Not found' });
  } catch (error) {
    const badRequest = error instanceof SyntaxError || /too large|limited to 20/.test(error.message);
    if (!badRequest) console.error('Request failed:', error);
    return send(response, badRequest ? 400 : 500, { error: badRequest ? error.message : 'Service unavailable' });
  }
});

await init();
server.listen(port, '0.0.0.0', () => console.log(`Northstar Lab API listening on ${port}`));
setInterval(() => advance().catch((error) => console.error('Worker failed:', error)), 750).unref();
