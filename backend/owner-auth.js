import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const sessionName = '__Host-northstar_session';
const stateName = '__Host-northstar_oauth_state';
const ownerGitHubId = 169708376;
const site = 'https://northstar-lab-woad.vercel.app';
const callback = `${site}/auth/github/callback`;

export function authEnabled(env = process.env) {
  return Boolean(env.NORTHSTAR_GITHUB_CLIENT_ID && env.NORTHSTAR_GITHUB_CLIENT_SECRET &&
    env.NORTHSTAR_SESSION_SECRET?.length >= 32 && /^[a-f0-9]{64}$/.test(env.NORTHSTAR_OWNER_WORKSPACE_ID || ''));
}

function cookies(request) {
  return Object.fromEntries(String(request.headers.cookie || '').split(';').map((part) => {
    const index = part.indexOf('=');
    return index < 0 ? [] : [part.slice(0, index).trim(), part.slice(index + 1).trim()];
  }).filter((pair) => pair.length === 2));
}

function signature(value, secret) {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

function safeEqual(a, b) {
  const left = Buffer.from(a || '');
  const right = Buffer.from(b || '');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function readOwnerSession(request, env = process.env) {
  if (!authEnabled(env)) return false;
  const [value, mac] = String(cookies(request)[sessionName] || '').split('.');
  if (!value || !mac || !safeEqual(signature(value, env.NORTHSTAR_SESSION_SECRET), mac)) return false;
  try {
    const payload = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    return payload.id === ownerGitHubId && Number.isSafeInteger(payload.expires) && payload.expires > Date.now();
  } catch { return false; }
}

function cookie(name, value, seconds) {
  return `${name}=${value}; Path=/; Max-Age=${seconds}; Secure; HttpOnly; SameSite=Lax`;
}

function redirect(response, location, cookieHeaders = []) {
  response.writeHead(302, { location, 'set-cookie': cookieHeaders, 'cache-control': 'no-store' });
  response.end();
}

export function startGitHubLogin(response, env = process.env) {
  if (!authEnabled(env)) return false;
  const state = randomBytes(32).toString('base64url');
  const destination = new URL('https://github.com/login/oauth/authorize');
  destination.searchParams.set('client_id', env.NORTHSTAR_GITHUB_CLIENT_ID);
  destination.searchParams.set('redirect_uri', callback);
  destination.searchParams.set('state', state);
  redirect(response, destination.toString(), [cookie(stateName, state, 600)]);
  return true;
}

export async function finishGitHubLogin(request, response, url, env = process.env, fetchImpl = fetch) {
  const state = cookies(request)[stateName];
  const clearState = cookie(stateName, '', 0);
  if (!authEnabled(env) || !state || !safeEqual(state, url.searchParams.get('state')) || !url.searchParams.get('code')) {
    redirect(response, `${site}/#login-error`, [clearState]);
    return;
  }
  try {
    const exchanged = await fetchImpl('https://github.com/login/oauth/access_token', {
      method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify({ client_id: env.NORTHSTAR_GITHUB_CLIENT_ID, client_secret: env.NORTHSTAR_GITHUB_CLIENT_SECRET,
        code: url.searchParams.get('code'), redirect_uri: callback }), signal: AbortSignal.timeout(10_000),
    });
    if (!exchanged.ok) throw new Error('GitHub token exchange failed');
    const token = (await exchanged.json()).access_token;
    if (typeof token !== 'string' || !token) throw new Error('GitHub did not return a token');
    const identity = await fetchImpl('https://api.github.com/user', {
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'user-agent': 'northstar-lab-owner-login' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!identity.ok || (await identity.json()).id !== ownerGitHubId) {
      redirect(response, `${site}/#not-owner`, [clearState]);
      return;
    }
    const value = Buffer.from(JSON.stringify({ id: ownerGitHubId, expires: Date.now() + 12 * 60 * 60_000 })).toString('base64url');
    redirect(response, `${site}/#overview`, [clearState, cookie(sessionName, `${value}.${signature(value, env.NORTHSTAR_SESSION_SECRET)}`, 12 * 60 * 60)]);
  } catch {
    redirect(response, `${site}/#login-error`, [clearState]);
  }
}

export function logoutOwner(response) {
  redirect(response, `${site}/#overview`, [cookie(sessionName, '', 0)]);
}

export function ownerRequestAllowed(request) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return true;
  return request.headers.origin === site;
}
