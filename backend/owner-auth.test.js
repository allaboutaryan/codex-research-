import assert from 'node:assert/strict';
import test from 'node:test';
import { authEnabled, finishGitHubLogin, ownerRequestAllowed, readOwnerSession, startGitHubLogin } from './owner-auth.js';

const env = { NORTHSTAR_GITHUB_CLIENT_ID: 'test-client', NORTHSTAR_GITHUB_CLIENT_SECRET: 'test-secret',
  NORTHSTAR_SESSION_SECRET: 's'.repeat(48), NORTHSTAR_OWNER_WORKSPACE_ID: 'a'.repeat(64) };
function response() { return { headers: null, writeHead(status, headers) { this.status = status; this.headers = headers; }, end() {} }; }
function cookieLine(headers, name) { return headers['set-cookie'].find((item) => item.startsWith(`${name}=`)).split(';')[0]; }

test('owner OAuth gates by exact GitHub user ID and signed short-lived cookie', async () => {
  assert.equal(authEnabled(env), true);
  assert.equal(authEnabled({ ...env, NORTHSTAR_SESSION_SECRET: 'short' }), false);
  const started = response();
  startGitHubLogin(started, env);
  assert.equal(started.status, 302);
  assert.match(started.headers.location, /^https:\/\/github.com\/login\/oauth\/authorize/);
  assert.doesNotMatch(started.headers.location, /scope=repo/);
  const stateCookie = cookieLine(started.headers, '__Host-northstar_oauth_state');
  const state = stateCookie.split('=')[1];
  const callback = new URL(`https://northstar-lab-woad.vercel.app/auth/github/callback?state=${state}&code=test-code`);
  const identity = (id) => async (url) => ({ ok: true, json: async () => url.includes('access_token') ? { access_token: 'test-token' } : { id } });
  const rejected = response();
  await finishGitHubLogin({ headers: { cookie: stateCookie } }, rejected, callback, env, identity(123));
  assert.match(rejected.headers.location, /not-owner/);
  assert.equal(rejected.headers['set-cookie'].some((line) => line.startsWith('__Host-northstar_session=')), false);
  const accepted = response();
  await finishGitHubLogin({ headers: { cookie: stateCookie } }, accepted, callback, env, identity(169708376));
  const session = cookieLine(accepted.headers, '__Host-northstar_session');
  assert.equal(readOwnerSession({ headers: { cookie: session } }, env), true);
  assert.equal(readOwnerSession({ headers: { cookie: `${session}x` } }, env), false);
  assert.equal(readOwnerSession({ headers: { cookie: session } }, { ...env, NORTHSTAR_SESSION_SECRET: 'q'.repeat(48) }), false);
  const forged = response();
  await finishGitHubLogin({ headers: { cookie: stateCookie } }, forged,
    new URL('https://northstar-lab-woad.vercel.app/auth/github/callback?state=wrong&code=test-code'), env, identity(169708376));
  assert.match(forged.headers.location, /login-error/);
  assert.equal(ownerRequestAllowed({ method: 'POST', headers: { origin: 'https://evil.example' } }), false);
  assert.equal(ownerRequestAllowed({ method: 'POST', headers: { origin: 'https://northstar-lab-woad.vercel.app' } }), true);
});
