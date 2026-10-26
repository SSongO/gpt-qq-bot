import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

export const ROOT = resolve(import.meta.dirname, '..');
const plain = x => x !== null && typeof x === 'object' && !Array.isArray(x);
export function merge(base, patch) {
  const out = structuredClone(base);
  for (const [key, value] of Object.entries(patch)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key) || !Object.hasOwn(base, key)) throw new Error('未知配置字段：' + key);
    out[key] = plain(base[key]) && plain(value) ? merge(base[key], value) : value;
  }
  return out;
}
export const defaults = () => JSON.parse(readFileSync(resolve(ROOT, 'config.example.json'), 'utf8'));
export function validate(c) {
  const fail = name => { throw new Error('配置无效：' + name); };
  const str = (v, name, max = 16000) => { if (typeof v !== 'string' || v.length > max) fail(name); };
  const int = (v, lo, hi, name) => { if (!Number.isInteger(v) || v < lo || v > hi) fail(name); };
  int(c.port, 1024, 65535, 'port');
  for (const section of ['openai', 'onebot', 'access', 'chat']) if (!plain(c[section])) fail(section);
  for (const k of ['baseUrl', 'apiKey', 'model', 'systemPrompt']) str(c.openai[k], 'openai.' + k);
  if (!['api-key', 'chatgpt'].includes(c.openai.authMode)) fail('openai.authMode');
  if (!c.openai.model.trim() || !c.openai.systemPrompt.trim()) fail('模型名/人格不能为空');
  for (const k of ['wsUrl', 'httpUrl', 'accessToken', 'eventSecret', 'botQQ']) str(c.onebot[k], 'onebot.' + k);
  for (const [value, protocols, name] of [[c.openai.baseUrl, ['https:', 'http:'], 'openai.baseUrl'], [c.onebot.httpUrl, ['https:', 'http:'], 'onebot.httpUrl'], [c.onebot.wsUrl, ['ws:', 'wss:'], 'onebot.wsUrl']]) {
    let u; try { u = new URL(value); } catch { fail(name); }
    if (!protocols.includes(u.protocol) || u.username || u.password || u.search || u.hash) fail(name);
    if (u.protocol === 'http:' && name === 'openai.baseUrl' && !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) fail('OpenAI 远程接口必须 HTTPS');
  }
  if (!['websocket', 'http'].includes(c.onebot.mode)) fail('onebot.mode');
  if (c.onebot.mode === 'http' && c.onebot.eventSecret.length < 16) fail('HTTP 上报密钥至少 16 位');
  if (!['mention', 'prefix', 'all'].includes(c.access.groupTrigger)) fail('access.groupTrigger');
  const id = x => typeof x === 'string' && /^\d+$/.test(x) && Number.isSafeInteger(Number(x)) && Number(x) > 0;
  for (const k of ['ownerQQ', 'prefix']) str(c.access[k], 'access.' + k, 128);
  for (const [k, v] of [['ownerQQ', c.access.ownerQQ], ['botQQ', c.onebot.botQQ]]) if (v && !id(v)) fail(k);
  if (!c.access.prefix.trim()) fail('prefix');
  for (const k of ['privateUsers', 'groups', 'blockedUsers']) if (!Array.isArray(c.access[k]) || c.access[k].length > 2000 || !c.access[k].every(id)) fail('access.' + k + ' 使用字符串 QQ 号数组');
  int(c.openai.maxOutputTokens, 64, 32768, 'maxOutputTokens');
  int(c.openai.timeoutMs, 1000, 300000, 'timeoutMs');
  const ranges = { historyTurns: [0, 100], historyMaxChars: [1000, 200000], sessionTtlMinutes: [1, 1440], maxSessions: [1, 2000], maxInputChars: [100, 50000], maxReplyChars: [100, 50000], chunkChars: [100, 4000], sendDelayMs: [0, 5000], cooldownMs: [0, 60000], maxConcurrent: [1, 10], maxPending: [1, 200], maxPendingPerSession: [1, 20] };
  for (const [k, range] of Object.entries(ranges)) int(c.chat[k], ...range, 'chat.' + k);
  return c;
}
export function atomicWrite(path, value) {
  const temp = path + '.tmp';
  writeFileSync(temp, value, { mode: 0o600 });
  renameSync(temp, path);
}
export function loadConfig(root = ROOT) {
  const path = resolve(root, 'config.json');
  if (!existsSync(path)) atomicWrite(path, JSON.stringify(defaults(), null, 2) + '\n');
  const c = merge(defaults(), JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')));
  return validate(c);
}
export function apiKey(config) { return process.env.OPENAI_API_KEY || config.openai.apiKey; }
export function safeConfig(config) {
  const c = structuredClone(config);
  c.openai.keyConfigured = Boolean(apiKey(config));
  c.openai.keyFromEnvironment = Boolean(process.env.OPENAI_API_KEY);
  c.openai.apiKey = '';
  c.onebot.tokenConfigured = Boolean(c.onebot.accessToken);
  c.onebot.secretConfigured = Boolean(c.onebot.eventSecret);
  c.onebot.accessToken = '';
  c.onebot.eventSecret = '';
  return c;
}
export function adminToken(root = ROOT) {
  const state = resolve(root, 'state');
  mkdirSync(state, { recursive: true });
  const path = resolve(state, 'admin-token');
  if (!existsSync(path)) atomicWrite(path, randomBytes(32).toString('hex'));
  return readFileSync(path, 'utf8').trim();
}
