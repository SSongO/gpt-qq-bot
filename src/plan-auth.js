import { randomBytes, randomUUID, createHash, createPublicKey, verify, timingSafeEqual } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { ROOT, atomicWrite } from './config.js';

export const RESOURCE = 'https://api.openai.com/v1';
export const ISSUER = 'https://auth.openai.com';
const TOKEN_URL = ISSUER + '/api/accounts/oauth/token';
const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
const SCOPES = 'openid profile email offline_access resource.invoke ' + PLAN_SCOPE;
const random = () => randomBytes(32).toString('base64url');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export class AuthError extends Error { constructor(code, status = 0) { super(code); this.code = code; this.status = status; } }

export function verifyIdToken(token, jwks, { clientId, nonce, subject = null, now = Date.now() / 1000 } = {}) {
  try {
    const parts = token.split('.'); if (parts.length !== 3) throw new Error();
    const header = JSON.parse(Buffer.from(parts[0], 'base64url'));
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url'));
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error();
    const key = jwks.keys.find(k => k.kid === header.kid && k.kty === 'RSA' && (!k.alg || k.alg === 'RS256') && (!k.use || k.use === 'sig'));
    if (!key || !verify('RSA-SHA256', Buffer.from(parts[0] + '.' + parts[1]), createPublicKey({ key, format: 'jwk' }), Buffer.from(parts[2], 'base64url'))) throw new Error();
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== ISSUER || !audience.includes(clientId) || (audience.length > 1 && claims.azp !== clientId)) throw new Error();
    if (!Number.isFinite(claims.exp) || claims.exp <= now || (claims.nbf && claims.nbf > now + 60) || (claims.iat && claims.iat > now + 60)) throw new Error();
    if (nonce !== undefined && !equal(claims.nonce, nonce)) throw new Error();
    if (typeof claims.sub !== 'string' || !claims.sub || (subject && subject !== claims.sub)) throw new Error();
    return { issuer: claims.iss, subject: claims.sub, email: typeof claims.email === 'string' ? claims.email : '', name: typeof claims.name === 'string' ? claims.name : '' };
  } catch { throw new AuthError('chatgpt_invalid_identity'); }
}
function secureDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    try {
      const identity = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
      const sid = identity.match(/S-1-\d+(?:-\d+)+/)?.[0];
      if (!sid) throw new Error();
      execFileSync('icacls.exe', [path, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F'], { stdio: 'pipe', windowsHide: true });
    } catch { throw new AuthError('chatgpt_storage_permissions'); }
  }
}
export class PlanAuth {
  constructor({ root = ROOT, fetchImpl = fetch, protect = true } = {}) {
    this.path = resolve(root, 'state/chatgpt/accounts.json');
    const directory = resolve(root, 'state/chatgpt');
    if (protect) secureDirectory(directory); else mkdirSync(directory, { recursive: true });
    this.fetch = fetchImpl; this.pending = null; this.refreshing = new Map(); this.busy = false; this.lastError = null;
    this.data = existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : { hostId: 'urn:uuid:' + randomUUID(), activeId: null, profiles: [] };
    this.save();
  }
  save() { atomicWrite(this.path, JSON.stringify(this.data, null, 2)); }
  active() { return this.data.profiles.find(p => p.id === this.data.activeId) ?? null; }
  status() {
    const selected = this.active();
    return { signedIn: Boolean(selected?.accessToken), planEnabled: Boolean(selected?.accessToken && selected.scopes?.includes(PLAN_SCOPE)), activeId: this.data.activeId,
      profiles: this.data.profiles.map(p => ({ id: p.id, label: p.label, email: p.email, connected: Boolean(p.accessToken), planEnabled: Boolean(p.accessToken && p.scopes?.includes(PLAN_SCOPE)) })),
      pending: Boolean(this.pending && this.pending.expiresAt > Date.now()), lastError: this.lastError, welcomeNeeded: Boolean(selected?.accessToken && selected.scopes?.includes(PLAN_SCOPE) && !selected.welcomed) };
  }
  begin(port, profileId = null, forceNew = false) {
    if (this.busy || this.refreshing.size) throw new AuthError('chatgpt_auth_busy');
    const profile = profileId ? this.data.profiles.find(p => p.id === profileId) : null;
    if (profileId && !profile) throw new AuthError('chatgpt_unknown_profile');
    const clientId = profile?.clientId ?? (forceNew ? null : this.retryClientId ?? null);
    const attempt = { state: random(), nonce: random(), verifier: random(), redirectUri: `http://127.0.0.1:${port}/auth/callback`, profileId: profile?.id ?? null, clientId, expiresAt: Date.now() + 600000 };
    const url = new URL(ISSUER + '/api/accounts/authorize');
    const fields = { client_id: clientId || 'dynamic_agent_client', ext_agent_host_id: this.data.hostId, response_type: 'code', redirect_uri: attempt.redirectUri, scope: SCOPES, resource: RESOURCE, state: attempt.state, nonce: attempt.nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(attempt.verifier).digest('base64url') };
    if (!clientId) fields.agent_name_hint = 'GPT QQ Bot';
    if (profile?.email) fields.login_hint = profile.email;
    for (const [key, value] of Object.entries(fields)) url.searchParams.set(key, value);
    this.pending = attempt; this.lastError = null;
    return { url: url.href, expiresAt: attempt.expiresAt };
  }
  async request(url, { form = null, headers = {}, method = form ? 'POST' : 'GET', allowEmpty = false } = {}) {
    try {
      const response = await this.fetch(url, { method, redirect: 'error', headers: { ...headers, ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) }, body: form?.toString(), signal: AbortSignal.timeout(20000) });
      const text = await response.text();
      if (response.status === 403 && /<(?:!doctype|html)/i.test(text)) throw new AuthError('chatgpt_network_blocked', 403);
      if (text.length > 2_000_000) throw new AuthError('chatgpt_invalid_response');
      let data; try { data = text ? JSON.parse(text) : {}; } catch { throw new AuthError('chatgpt_invalid_response'); }
      if (!response.ok) throw new AuthError(data.error === 'invalid_grant' ? 'chatgpt_login_expired' : 'chatgpt_auth_failed', response.status);
      if (!text && !allowEmpty) throw new AuthError('chatgpt_invalid_response');
      return data;
    } catch (e) { if (e instanceof AuthError) throw e; throw new AuthError('chatgpt_network_error'); }
  }
  async discovery() {
    if (!this.metadata) {
      const value = await this.request(ISSUER + '/.well-known/openid-configuration');
      if (value.issuer !== ISSUER) throw new AuthError('chatgpt_invalid_identity');
      for (const field of ['jwks_uri', 'revocation_endpoint']) {
        if (!value[field]) continue;
        const u = new URL(value[field]);
        if (u.origin !== ISSUER || u.username || u.password) throw new AuthError('chatgpt_invalid_identity');
      }
      if (!value.jwks_uri) throw new AuthError('chatgpt_invalid_identity');
      this.metadata = value;
    }
    return this.metadata;
  }
  async identity(token, checks) {
    const metadata = await this.discovery();
    const keys = await this.request(metadata.jwks_uri);
    return verifyIdToken(token, keys, checks);
  }
  tokenFields(tokens, old = {}) {
    if (typeof tokens.access_token !== 'string' || !tokens.access_token || tokens.token_type?.toLowerCase() !== 'bearer' || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) throw new AuthError('chatgpt_invalid_response');
    const scopes = typeof tokens.scope === 'string' ? tokens.scope.split(/\s+/).filter(Boolean) : old.scopes ?? [];
    return { accessToken: tokens.access_token, refreshToken: typeof tokens.refresh_token === 'string' ? tokens.refresh_token : old.refreshToken ?? null, idToken: tokens.id_token || old.idToken || null, scopes, expiresAt: Date.now() + tokens.expires_in * 1000 };
  }
  async callback(params) {
    if (this.busy || this.refreshing.size) throw new AuthError('chatgpt_auth_busy');
    const attempt = this.pending;
    if (!attempt || attempt.expiresAt < Date.now() || !equal(params.get('state'), attempt.state)) throw new AuthError('chatgpt_invalid_state');
    this.pending = null;
    if (params.get('error')) { this.lastError = 'chatgpt_access_denied'; throw new AuthError(this.lastError); }
    const clientId = params.get('client_id') || attempt.clientId;
    if (!clientId || clientId === 'dynamic_agent_client' || (attempt.clientId && attempt.clientId !== clientId) || !params.get('code')) throw new AuthError('chatgpt_invalid_callback');
    this.busy = true;
    try {
      const tokens = await this.request(TOKEN_URL, { form: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code: params.get('code'), code_verifier: attempt.verifier, redirect_uri: attempt.redirectUri, resource: RESOURCE }) });
      const previous = this.data.profiles.find(p => p.id === attempt.profileId);
      const identity = await this.identity(tokens.id_token, { clientId, nonce: attempt.nonce, subject: previous?.subject });
      if (previous && previous.issuer !== identity.issuer) throw new AuthError('chatgpt_invalid_identity');
      const fields = this.tokenFields(tokens); // Granted scopes come from the token endpoint only.
      const profile = { id: previous?.id ?? randomUUID(), clientId, ...identity, label: previous?.label || `${identity.email || identity.name || 'ChatGPT'} · 连接 ${this.data.profiles.length + 1}`, ...fields, welcomed: previous?.welcomed ?? false };
      if (previous) Object.assign(previous, profile); else this.data.profiles.push(profile);
      this.data.activeId = profile.id; this.save(); this.lastError = null; this.retryClientId = null;
      return this.status();
    } catch (e) { this.lastError = e instanceof AuthError ? e.code : 'chatgpt_auth_failed'; if (e.code === 'chatgpt_login_expired') this.retryClientId = clientId; throw new AuthError(this.lastError); }
    finally { this.busy = false; }
  }
  select(id) {
    if (this.busy || this.refreshing.size) throw new AuthError('chatgpt_auth_busy');
    if (!this.data.profiles.some(p => p.id === id)) throw new AuthError('chatgpt_unknown_profile');
    this.pending = null; this.data.activeId = id; this.save(); return this.status();
  }
  welcome() { const p = this.active(); if (p) { p.welcomed = true; this.save(); } }
  async accessToken() {
    if (this.busy) throw new AuthError('chatgpt_auth_busy');
    const p = this.active();
    if (!p?.accessToken) throw new AuthError('chatgpt_not_signed_in');
    if (!p.scopes?.includes(PLAN_SCOPE)) throw new AuthError('chatgpt_plan_not_enabled');
    if (p.expiresAt > Date.now() + 60000) return p.accessToken;
    if (!this.refreshing.has(p.id)) {
      const refresh = (async () => {
        if (!p.refreshToken) throw new AuthError('chatgpt_login_expired');
        try {
          const tokens = await this.request(TOKEN_URL, { form: new URLSearchParams({ grant_type: 'refresh_token', client_id: p.clientId, refresh_token: p.refreshToken, resource: RESOURCE }) });
          if (tokens.id_token) await this.identity(tokens.id_token, { clientId: p.clientId, subject: p.subject });
          const fields = this.tokenFields(tokens, p);
          Object.assign(p, fields); this.save();
          if (!p.scopes.includes(PLAN_SCOPE)) throw new AuthError('chatgpt_plan_not_enabled');
          return p.accessToken;
        } catch (e) {
          if (e.code === 'chatgpt_login_expired') { p.accessToken = null; p.refreshToken = null; p.idToken = null; this.save(); }
          throw e;
        }
      })().finally(() => this.refreshing.delete(p.id));
      this.refreshing.set(p.id, refresh);
    }
    return this.refreshing.get(p.id);
  }
  async models() {
    const token = await this.accessToken();
    const data = await this.request(RESOURCE + '/models', { headers: { Authorization: 'Bearer ' + token } });
    return (data.models ?? []).filter(m => m.visibility === 'list' && typeof m.slug === 'string').map(m => ({ id: m.slug, name: typeof m.display_name === 'string' ? m.display_name : m.slug }));
  }
  async logout() {
    if (this.busy || this.refreshing.size) throw new AuthError('chatgpt_auth_busy');
    this.pending = null;
    const p = this.active(); if (!p) return { remoteRevocationConfirmed: true };
    this.busy = true; let confirmed = false;
    try {
      if (p.refreshToken) {
        const discovery = await this.discovery();
        if (discovery.revocation_endpoint) {
          for (let attempt = 0; attempt < 2; attempt++) {
            try { await this.request(discovery.revocation_endpoint, { form: new URLSearchParams({ token: p.refreshToken, token_type_hint: 'refresh_token', client_id: p.clientId }), allowEmpty: true }); confirmed = true; break; }
            catch { if (!attempt) await new Promise(r => setTimeout(r, 500)); }
          }
        }
      } else confirmed = !p.accessToken;
    } catch { /* Report unconfirmed revocation without exposing upstream errors. */ }
    finally { p.accessToken = null; p.refreshToken = null; p.idToken = null; p.scopes = []; this.save(); this.busy = false; }
    return { remoteRevocationConfirmed: confirmed };
  }
}
let singleton;
export function getPlanAuth() { return singleton ??= new PlanAuth(); }
