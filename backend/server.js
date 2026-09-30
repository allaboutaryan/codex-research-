import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';

const port = Number(process.env.PORT || 8787);
const pool = process.env.DATABASE_URL ? new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 }) : null;
const memory = new Map();
const phases = [
  ['Project manager', 'Scoped the assignment and set a review gate.'],
  ['Team lead', 'Assigned the task to the research worker.'],
  ['Research worker', 'Submitted a sample work packet for review.'],
  ['Quality reviewer', 'Requested one revision in this workflow demo.'],
  ['Research worker', 'Returned a revised sample work packet.'],
  ['Quality reviewer', 'Confirmed the sample review handoff.'],
  ['Project manager', 'Closed the workflow walkthrough. No research was performed.'],
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
    CREATE INDEX IF NOT EXISTS idx_tasks_workspace_created ON tasks(workspace_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_events_workspace_id ON events(workspace_id, id DESC);
  `);
}

async function ensureWorkspace(workspace) {
  if (!pool) {
    if (!memory.has(workspace)) memory.set(workspace, { tasks: [], events: [], nextId: 1 });
    return;
  }
  await pool.query('INSERT INTO workspaces (id) VALUES ($1) ON CONFLICT DO NOTHING', [workspace]);
}

async function readState(workspace) {
  await ensureWorkspace(workspace);
  if (!pool) {
    const state = memory.get(workspace);
    return { tasks: [...state.tasks].reverse(), events: [...state.events].reverse().slice(0, 50) };
  }
  const [tasks, events] = await Promise.all([
    pool.query('SELECT * FROM tasks WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT 30', [workspace]),
    pool.query('SELECT * FROM events WHERE workspace_id = $1 ORDER BY id DESC LIMIT 50', [workspace]),
  ]);
  return { tasks: tasks.rows, events: events.rows };
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
        const [role, message] = phases[task.step];
        state.events.push({ id: state.nextId++, workspace_id: workspace, task_id: task.id, role, message, created_at: new Date().toISOString() });
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
    const result = await client.query("SELECT id, workspace_id, step FROM tasks WHERE status = 'running' AND updated_at < now() - interval '1.6 seconds' ORDER BY updated_at LIMIT 1 FOR UPDATE SKIP LOCKED");
    const task = result.rows[0];
    if (!task) {
      await client.query('COMMIT');
      return;
    }
    const [role, message] = phases[task.step];
    const nextStep = task.step + 1;
    await client.query('UPDATE tasks SET step = $1, status = $2, updated_at = now() WHERE id = $3', [nextStep, nextStep >= phases.length ? 'complete' : 'running', task.id]);
    await client.query('INSERT INTO events (workspace_id, task_id, role, message) VALUES ($1, $2, $3, $4)', [task.workspace_id, task.id, role, message]);
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
      return send(response, 200, { ...state, mode: 'demo', modelCalls: 0, inputTokens: 0, outputTokens: 0, maxTasks: 20 });
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
