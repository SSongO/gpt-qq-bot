import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { PlanAuth, verifyIdToken, ISSUER, RESOURCE, credentialDirectory } from '../src/plan-auth.js';
import { generateWithPlan, userError } from '../src/provider.js';
import { defaults } from '../src/config.js';
import { Bot } from '../src/bot.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'fixture-key', alg: 'RS256', use: 'sig' };
const now = () => Math.floor(Date.now() / 1000);
function jwt({ audience = 'oaiapp_fixture', nonce = 'nonce', subject = 'subject-1', expiration = now() + 3600, issuer = ISSUER } = {}) {
  const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ iss: issuer, aud: audience, nonce, sub: subject, exp: expiration, iat: now(), email: 'example@example.test' })).toString('base64url');
  return head + '.' + body + '.' + sign('RSA-SHA256', Buffer.from(head + '.' + body), privateKey).toString('base64url');
}
const scopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
test('different Windows identities use distinct stable credential stores', () => {
  const root = resolve(tmpdir(), 'gpt-qq-store-path');
  const a = credentialDirectory(root, { platform: 'win32', sid: 'S-1-5-21-1001' });
  const b = credentialDirectory(root, { platform: 'win32', sid: 'S-1-5-21-1002' });
  assert.notEqual(a, b); assert.equal(a, credentialDirectory(root, { platform: 'win32', sid: 'S-1-5-21-1001' }));
  assert.ok(a.startsWith(root)); assert.throws(() => credentialDirectory(root, { platform: 'win32', sid: '../other-user' }));
});
const json = data => new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), 'gpt-qq-oauth-')); const requests = [];
  let tokenResponse, refreshResponse, revokeFails = false;
  const auth = new PlanAuth({ root, protect: false, fetchImpl: async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/openid-configuration')) return json({ issuer: ISSUER, jwks_uri: ISSUER + '/jwks', revocation_endpoint: ISSUER + '/revoke' });
    if (url.endsWith('/jwks')) return json({ keys: [jwk] });
    if (url.endsWith('/oauth/token')) {
      const form = new URLSearchParams(options.body);
      return form.get('grant_type') === 'refresh_token' ? (refreshResponse?.() ?? json({ access_token: 'refreshed-access', refresh_token: 'rotated-refresh', token_type: 'Bearer', expires_in: 3600 })) : json(tokenResponse);
    }
    if (url.endsWith('/models')) return json({ models: [{ slug: 'model-visible', display_name: 'Visible', visibility: 'list' }, { slug: 'hidden', visibility: 'hide' }] });
    if (url.endsWith('/revoke')) { if (revokeFails) throw new Error('offline'); return new Response(null, { status: 200 }); }
    throw new Error('unexpected endpoint');
  } });
  function begin(profileId = null, tokenScope = scopes, claims = {}) {
    const attempt = auth.begin(3100, profileId); const params = new URL(attempt.url).searchParams;
    tokenResponse = { access_token: 'fixture-access', refresh_token: 'fixture-refresh', id_token: jwt({ nonce: params.get('nonce'), ...claims }), token_type: 'Bearer', expires_in: 3600, scope: tokenScope };
    const callback = new URLSearchParams({ code: 'fixture-code', state: params.get('state'), client_id: 'oaiapp_fixture' });
    return { attempt, params, callback };
  }
  return { auth, root, requests, begin, cleanup: () => rmSync(root, { recursive: true, force: true }), setRefresh: fn => refreshResponse = fn, failRevocation: () => revokeFails = true };
}
test('ID tokens are signature verified, with issuer/audience/nonce/expiry checks', () => {
  const check = { clientId: 'oaiapp_fixture', nonce: 'nonce' };
  assert.equal(verifyIdToken(jwt(), { keys: [jwk] }, check).subject, 'subject-1');
  for (const token of [jwt({ audience: 'other' }), jwt({ nonce: 'other' }), jwt({ issuer: 'https://evil.example' }), jwt({ expiration: now() - 1 }), jwt().slice(0, -5) + 'abcde']) assert.throws(() => verifyIdToken(token, { keys: [jwk] }, check), /chatgpt_invalid_identity/);
  assert.throws(() => verifyIdToken(jwt(), { keys: [jwk] }, { ...check, subject: 'other' }));
});
test('initial authorization uses dynamic registration, stable host ID, nonce and PKCE', () => {
  const f = fixture();
  try {
    const a = f.begin(), pending = { ...f.auth.pending };
    assert.equal(new URL(a.attempt.url).origin, ISSUER); assert.equal(a.params.get('client_id'), 'dynamic_agent_client'); assert.equal(a.params.get('agent_name_hint'), 'GPT QQ Bot');
    assert.equal(a.params.get('resource'), RESOURCE); assert.equal(a.params.get('redirect_uri'), 'http://127.0.0.1:3100/auth/callback');
    assert.equal(a.params.get('code_challenge'), createHash('sha256').update(pending.verifier).digest('base64url'));
    const b = f.begin(); assert.equal(b.params.get('ext_agent_host_id'), a.params.get('ext_agent_host_id')); assert.notEqual(b.params.get('state'), a.params.get('state'));
    const reload = new PlanAuth({ root: f.root, protect: false }); assert.equal(reload.data.hostId, f.auth.data.hostId);
  } finally { f.cleanup(); }
});
test('OAuth callback validates state and issued client ID before exchanging a code', async () => {
  const f = fixture(); try {
    const { callback } = f.begin(); callback.set('state', 'invalid'); await assert.rejects(f.auth.callback(callback), /invalid_state/); assert.equal(f.requests.length, 0);
    const a = f.begin(); a.callback.delete('client_id'); await assert.rejects(f.auth.callback(a.callback), /invalid_callback/); assert.equal(f.requests.length, 0);
    const b = f.begin(); b.callback.set('error', 'access_denied'); await assert.rejects(f.auth.callback(b.callback), /access_denied/); assert.equal(f.requests.length, 0);
  } finally { f.cleanup(); }
});
test('verified registration persists credentials but never returns them in public status', async () => {
  const f = fixture(); try {
    const { callback } = f.begin(); const status = await f.auth.callback(callback); assert.equal(status.planEnabled, true); assert.equal(status.welcomeNeeded, true);
    const text = JSON.stringify(status); for (const value of ['fixture-access', 'fixture-refresh', 'idToken', 'accessToken', 'refreshToken']) assert.ok(!text.includes(value));
    const request = f.requests.find(r => r.url.endsWith('/oauth/token')); const form = new URLSearchParams(request.options.body); assert.equal(form.get('client_id'), 'oaiapp_fixture'); assert.equal(form.get('resource'), RESOURCE); assert.equal(form.get('client_secret'), null); assert.equal(form.get('redirect_uri'), 'http://127.0.0.1:3100/auth/callback');
    const saved = JSON.parse(readFileSync(f.auth.path)); assert.equal(saved.profiles[0].clientId, 'oaiapp_fixture'); assert.equal(saved.profiles[0].subject, 'subject-1');
    f.auth.welcome(); assert.equal(f.auth.status().welcomeNeeded, false);
  } finally { f.cleanup(); }
});
test('identity-only sign-in cannot spend ChatGPT plan usage', async () => {
  const f = fixture(); try { const { callback } = f.begin(null, 'openid profile email'); await f.auth.callback(callback); assert.equal(f.auth.status().signedIn, true); assert.equal(f.auth.status().planEnabled, false); await assert.rejects(f.auth.accessToken(), /plan_not_enabled/); }
  finally { f.cleanup(); }
});
test('an HTML authorization block is reported without treating it as a token response', async () => {
  const f = fixture(); try { f.auth.fetch = async () => new Response('<html>blocked</html>', { status: 403 }); let caught; try { await f.auth.discovery(); } catch (e) { caught = e; } assert.equal(caught.code, 'chatgpt_network_blocked'); assert.match(userError(caught), /403/); }
  finally { f.cleanup(); }
});
test('returning login reuses the issued client and rejects a changed identity or registration', async () => {
  const f = fixture(); try {
    await f.auth.callback(f.begin().callback); const selected = f.auth.active();
    const a = f.begin(selected.id); assert.equal(a.params.get('client_id'), 'oaiapp_fixture'); assert.equal(a.params.has('agent_name_hint'), false);
    a.callback.set('client_id', 'other-client'); await assert.rejects(f.auth.callback(a.callback), /invalid_callback/);
    const b = f.begin(selected.id, scopes, { subject: 'subject-2' }); await assert.rejects(f.auth.callback(b.callback), /invalid_identity/); assert.equal(f.auth.active().subject, 'subject-1'); assert.equal(f.auth.active().accessToken, 'fixture-access');
  } finally { f.cleanup(); }
});
test('concurrent refresh is serialized and rotates the entire token set atomically', async () => {
  const f = fixture(); try {
    await f.auth.callback(f.begin().callback); f.auth.active().expiresAt = Date.now();
    const values = await Promise.all([f.auth.accessToken(), f.auth.accessToken(), f.auth.accessToken()]); assert.deepEqual(values, ['refreshed-access', 'refreshed-access', 'refreshed-access']);
    assert.equal(f.requests.filter(r => r.url.endsWith('/oauth/token') && new URLSearchParams(r.options.body).get('grant_type') === 'refresh_token').length, 1);
    const saved = JSON.parse(readFileSync(f.auth.path)); assert.equal(saved.profiles[0].refreshToken, 'rotated-refresh'); assert.ok(saved.profiles[0].scopes.includes('chatgpt.tokens.use.direct'));
    const form = new URLSearchParams(f.requests.at(-1).options.body); assert.equal(form.get('scope'), null); assert.equal(form.get('client_id'), 'oaiapp_fixture');
  } finally { f.cleanup(); }
});
test('invalid refresh clears local tokens while preserving the registered client', async () => {
  const f = fixture(); try {
    await f.auth.callback(f.begin().callback); f.auth.active().expiresAt = Date.now(); f.setRefresh(() => new Response('{"error":"invalid_grant"}', { status: 400 }));
    await assert.rejects(f.auth.accessToken(), /login_expired/); assert.equal(f.auth.active().clientId, 'oaiapp_fixture'); assert.equal(f.auth.active().accessToken, null); assert.equal(f.auth.active().refreshToken, null);
  } finally { f.cleanup(); }
});
test('an expired authorization code is retried with its issued registration', async () => {
  const f = fixture(); try {
    const attempt = f.begin(); const original = f.auth.fetch;
    f.auth.fetch = async (url, options) => url.endsWith('/oauth/token') ? new Response('{"error":"invalid_grant"}', { status: 400 }) : original(url, options);
    await assert.rejects(f.auth.callback(attempt.callback), /login_expired/);
    const retry = new URL(f.auth.begin(3100).url); assert.equal(retry.searchParams.get('client_id'), 'oaiapp_fixture'); assert.equal(retry.searchParams.has('agent_name_hint'), false);
    const fresh = new URL(f.auth.begin(3100, null, true).url); assert.equal(fresh.searchParams.get('client_id'), 'dynamic_agent_client');
  } finally { f.cleanup(); }
});
test('models use the OAuth bearer credential and filter account visibility', async () => {
  const f = fixture(); try {
    await f.auth.callback(f.begin().callback); assert.deepEqual(await f.auth.models(), [{ id: 'model-visible', name: 'Visible' }]); assert.equal(f.requests.at(-1).options.headers.Authorization, 'Bearer fixture-access');
  } finally { f.cleanup(); }
});
test('logout revokes the refresh session and retains only account registration', async () => {
  const f = fixture(); try {
    await f.auth.callback(f.begin().callback); assert.equal((await f.auth.logout()).remoteRevocationConfirmed, true); assert.equal(f.auth.status().signedIn, false); assert.equal(f.auth.active().clientId, 'oaiapp_fixture');
    const form = new URLSearchParams(f.requests.find(r => r.url.endsWith('/revoke')).options.body); assert.equal(form.get('token'), 'fixture-refresh'); assert.equal(form.get('token_type_hint'), 'refresh_token');
  } finally { f.cleanup(); }
});
test('logout reports unconfirmed remote revocation on network failure', async () => {
  const f = fixture(); try { await f.auth.callback(f.begin().callback); f.failRevocation(); assert.equal((await f.auth.logout()).remoteRevocationConfirmed, false); assert.equal(f.auth.status().signedIn, false); }
  finally { f.cleanup(); }
});
function sse(events) {
  const bytes = Buffer.from(events.map(e => 'data: ' + JSON.stringify(e) + '\r\n\r\n').join(''));
  const stream = new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.subarray(i, i + 7)); controller.close(); } });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
}
const plan = { accessToken: async () => 'plan-test-token' };
test('plan inference uses only the official endpoint with required streaming fields', async () => {
  const config = defaults(); config.openai.authMode = 'chatgpt'; config.openai.baseUrl = 'https://untrusted.example/v1';
  let request;
  const result = await generateWithPlan(config, [{ role: 'user', content: '你好' }], { planAuth: plan, fetchImpl: async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return sse([{ type: 'response.output_text.delta', delta: '你好😀' }, { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 2, output_tokens: 3 }, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '你好😀' }] }] } }]);
  } });
  assert.equal(result.text, '你好😀'); assert.equal(result.usage.output_tokens, 3); assert.equal(request.url, RESOURCE + '/responses'); assert.equal(request.options.headers.Authorization, 'Bearer plan-test-token');
  assert.equal(request.body.stream, true); assert.equal(request.body.store, false); assert.equal('max_output_tokens' in request.body, false); assert.equal('previous_response_id' in request.body, false);
});
test('late subscription-limit failures reject partial output and surface usage guidance', async () => {
  const config = defaults(); let caught;
  try { await generateWithPlan(config, [], { planAuth: plan, fetchImpl: async () => sse([{ type: 'response.output_text.delta', delta: 'partial' }, { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } }]) }); } catch (e) { caught = e; }
  assert.equal(caught.code, 'chatgpt_usage_limit'); assert.match(userError(caught), /管理用量/);
});
test('plan inference rejects truncated streams and incomplete terminal events', async () => {
  for (const events of [[{ type: 'response.output_text.delta', delta: 'partial' }], [{ type: 'response.incomplete', response: {} }]]) {
    await assert.rejects(generateWithPlan(defaults(), [], { planAuth: plan, fetchImpl: async () => sse(events) }), /chatgpt_(interrupted_stream|incomplete)/);
  }
});
test('plan inference never falls back to an API key after login/usage failure', async () => {
  let requests = 0;
  const auth = { accessToken: async () => { throw Object.assign(new Error('not signed in'), { code: 'chatgpt_not_signed_in' }); } };
  await assert.rejects(generateWithPlan(defaults(), [], { planAuth: auth, fetchImpl: async () => { requests++; return json({}); } }), /not signed in/); assert.equal(requests, 0);
});
test('account changes discard in-flight replies and queued old-account messages', async () => {
  const config = defaults(); config.access.ownerQQ = '100'; config.chat.cooldownMs = 0;
  let release; const gate = new Promise(r => release = r); const sent = []; let calls = 0;
  const bot = new Bot(config, { send: async (_, text) => sent.push(text), model: async () => { calls++; await gate; return { text: 'old-account-response', usage: {} }; } });
  const event = n => ({ post_type: 'message', self_id: 999, user_id: 100, message_type: 'private', message: 'hello', message_id: n });
  const a = bot.accept(event(1)), b = bot.accept(event(2)); await new Promise(r => setTimeout(r, 1)); bot.invalidateSessions(); release(); await Promise.all([a, b]); assert.deepEqual(sent, []); assert.equal(calls, 1);
});
