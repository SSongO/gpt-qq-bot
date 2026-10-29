import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaults, validate, merge, safeConfig, loadConfig } from '../src/config.js';
import { Bot, parseMessage, routeEvent } from '../src/bot.js';
import { generate, extractText, userError, ServiceError } from '../src/provider.js';
import { OneBot } from '../src/onebot.js';
import { createServer } from '../src/server.js';
import { Script } from 'node:vm';

// All model traffic goes to a loopback fixture, with a dummy key.
process.env.OPENAI_API_KEY = 'test-key';
const config = () => { const c = defaults(); c.access.ownerQQ = '100'; c.access.groups = ['200']; c.chat.cooldownMs = 0; c.chat.sendDelayMs = 0; c.chat.continuationSeconds = 0; return c; };
const event = (message = '你好', extra = {}) => ({ post_type: 'message', message_type: 'private', self_id: 999, user_id: 100, message_id: Math.random().toString(16), message, ...extra });
const modelResult = text => ({ text, usage: { input_tokens: 3, output_tokens: 2 } });
const mention = text => [{ type: 'at', data: { qq: '999' } }, { type: 'text', data: { text } }];
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return 'http://127.0.0.1:' + server.address().port; }
async function close(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
async function eventually(check) { for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(r => setTimeout(r, 10)); } assert.fail('condition timed out'); }

test('configuration blocks unknown fields, insecure remote OpenAI URLs, and invalid IDs', () => {
  assert.doesNotThrow(() => validate(defaults()));
  assert.throws(() => merge(defaults(), { surprise: true }));
  assert.throws(() => merge(defaults(), JSON.parse('{"__proto__":{}}')));
  const c = config(); c.openai.baseUrl = 'http://remote.example/v1'; assert.throws(() => validate(c));
  c.openai.baseUrl = 'https://example.com/v1?secret=1'; assert.throws(() => validate(c));
  c.openai.baseUrl = 'https://api.openai.com/v1'; c.access.groups = [200]; assert.throws(() => validate(c));
});
test('HTTP mode requires an event signing secret', () => {
  const c = config(); c.onebot.mode = 'http'; assert.throws(() => validate(c));
  c.onebot.eventSecret = '1234567890123456'; assert.doesNotThrow(() => validate(c));
});
test('configuration initializes and redacts all secrets', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gpt-qq-config-'));
  try { const c = loadConfig(dir); c.openai.apiKey = 'private-key'; c.onebot.accessToken = 'qq-secret'; c.onebot.eventSecret = 'event-secret'; const safe = JSON.stringify(safeConfig(c)); assert.ok(!safe.includes('private-key')); assert.ok(!safe.includes('qq-secret')); assert.ok(!safe.includes('event-secret')); assert.ok(JSON.parse(safe).openai.keyConfigured); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});
test('default empty allowlists deny all messages', () => {
  assert.equal(routeEvent(event(), defaults()), null);
  assert.equal(routeEvent(event(mention('你好'), { message_type: 'group', group_id: 200 }), defaults()), null);
});
test('self messages, notices, blocked people, other bot accounts and malformed IDs are ignored', () => {
  const c = config();
  for (const e of [event('x', { user_id: 999 }), event('x', { post_type: 'notice' }), event('x', { user_id: null }), event('x', { self_id: null })]) assert.equal(routeEvent(e, c), null);
  c.access.blockedUsers = ['100']; assert.equal(routeEvent(event(), c), null);
  c.access.blockedUsers = []; c.onebot.botQQ = '888'; assert.equal(routeEvent(event(), c), null);
});
test('group routing requires the allowed group and a real mention', () => {
  const c = config();
  assert.equal(routeEvent(event('你好', { message_type: 'group', group_id: 200 }), c), null);
  assert.equal(routeEvent(event(mention('你好'), { message_type: 'group', group_id: 201 }), c), null);
  assert.equal(routeEvent(event(mention('你好'), { message_type: 'group', group_id: 200 }), c).text, '你好');
  assert.equal(routeEvent(event('[CQ:at,qq=all] x', { message_type: 'group', group_id: 200 }), c), null);
});
test('CQ string and array parsing removes metadata and preserves escaped literal text', () => {
  assert.deepEqual(parseMessage('[CQ:reply,id=1][CQ:at,qq=999] 你好 [CQ:image,file=x]', 999), { text: '你好', mentioned: true });
  assert.deepEqual(parseMessage('&#91;CQ:at,qq=999&#93; &amp; hi', 999), { text: '[CQ:at,qq=999] & hi', mentioned: false });
  assert.deepEqual(parseMessage([{ type: 'image', data: { file: 'x' } }], 999), { text: '', mentioned: false });
});
test('prefix mode requires a whole prefix and strips it', () => {
  const c = config(); c.access.groupTrigger = 'prefix';
  const group = { message_type: 'group', group_id: 200 };
  assert.equal(routeEvent(event('/askfoo', group), c), null);
  assert.equal(routeEvent(event('/ask 你好', group), c).text, '你好');
  c.access.groupTrigger = 'all'; assert.equal(routeEvent(event('hi', group), c).text, 'hi');
});

test('mixed group mode validates the configured percentage and preserves old defaults', () => {
  const c = config(); c.access.groupTrigger = 'mention-or-random';
  for (const value of [0, 10, 100]) { c.access.groupReplyChance = value; assert.doesNotThrow(() => validate(c)); }
  for (const value of [-1, 101, 10.5, '10', NaN]) { c.access.groupReplyChance = value; assert.throws(() => validate(c)); }
  const old = config(); delete old.access.groupReplyChance;
  assert.equal(merge(defaults(), old).access.groupReplyChance, 10);
});

test('mixed mode always routes real mentions, including a bare mention, without drawing a probability', async () => {
  const c = config(); c.access.groupTrigger = 'mention-or-random'; c.access.groupReplyChance = 0;
  const sent = [];
  const bot = new Bot(c, { random: () => { throw Error('mentions must not draw'); }, model: async () => modelResult('收到'), send: async (_, text) => sent.push(text) });
  await bot.accept(event(mention('你好'), { message_type: 'group', group_id: 200 }));
  await bot.accept(event('[CQ:at,qq=999]', { message_type: 'group', group_id: 200 }));
  assert.deepEqual(sent, ['收到', '收到']);
});

test('ordinary group messages independently use the exact configured probability boundary', async () => {
  const c = config(); c.access.groupTrigger = 'mention-or-random'; c.access.groupReplyChance = 10;
  const draws = [0, 0.099999, 0.1, 0.99]; let calls = 0;
  const bot = new Bot(c, { random: () => draws.shift(), model: async () => { calls++; return modelResult('好'); }, send: async () => {} });
  for (let i = 0; i < 4; i++) await bot.accept(event('闲聊 ' + i, { message_type: 'group', group_id: 200 }));
  assert.equal(calls, 2); assert.equal(draws.length, 0); assert.equal(bot.stats.ignored, 2);
});

test('zero and full probability affect only ordinary group messages, not allowed private chats', async () => {
  for (const chance of [0, 100]) {
    const c = config(); c.access.groupTrigger = 'mention-or-random'; c.access.groupReplyChance = chance;
    let calls = 0;
    const bot = new Bot(c, { random: () => 0.5, model: async () => { calls++; return modelResult('好'); }, send: async () => {} });
    await bot.accept(event('普通群消息', { message_type: 'group', group_id: 200 }));
    await bot.accept(event('私聊'));
    assert.equal(calls, chance === 0 ? 1 : 2);
  }
});

test('repeated gateway delivery of a skipped random message cannot reroll', async () => {
  const c = config(); c.access.groupTrigger = 'mention-or-random';
  let draws = 0, calls = 0;
  const bot = new Bot(c, { random: () => ++draws === 1 ? 0.9 : 0, model: async () => { calls++; return modelResult('好'); }, send: async () => {} });
  const e = event('闲聊', { message_type: 'group', group_id: 200 });
  await bot.accept(e); await bot.accept(e);
  assert.equal(draws, 1); assert.equal(calls, 0);
});

test('mixed mode still enforces group allowlists, blocks and actual mention targets', async () => {
  const c = config(); c.access.groupTrigger = 'mention-or-random'; c.access.groupReplyChance = 0;
  c.access.blockedUsers = ['101']; let calls = 0;
  const bot = new Bot(c, { random: () => 0.9, model: async () => { calls++; return modelResult('好'); }, send: async () => {} });
  for (const e of [
    event(mention('你好'), { message_type: 'group', group_id: 201 }),
    event(mention('你好'), { message_type: 'group', group_id: 200, user_id: 101 }),
    event('[CQ:at,qq=all] hi', { message_type: 'group', group_id: 200 }),
    event('[CQ:at,qq=888] hi', { message_type: 'group', group_id: 200 }),
    event('&#91;CQ:at,qq=999&#93; hi', { message_type: 'group', group_id: 200 })
  ]) await bot.accept(e);
  assert.equal(calls, 0);
});

test('a direct group mention bypasses ordinary cooldown while retaining queue capacity limits', async () => {
  const c = config(); c.access.groupTrigger = 'mention-or-random'; c.access.groupReplyChance = 100; c.chat.cooldownMs = 60000;
  let calls = 0;
  const bot = new Bot(c, { random: () => 0, model: async () => { calls++; return modelResult('好'); }, send: async () => {} });
  await bot.accept(event('普通消息', { message_type: 'group', group_id: 200 }));
  await bot.accept(event(mention('问你呢'), { message_type: 'group', group_id: 200 }));
  await bot.accept(event('另一条普通消息', { message_type: 'group', group_id: 200 }));
  assert.equal(calls, 2); assert.equal(bot.stats.throttled, 1);
  c.chat.maxPendingPerSession = 1;
  let release; const gate = new Promise(r => release = r);
  bot.model = async () => { await gate; return modelResult('好'); };
  const first = bot.accept(event(mention('问题一'), { message_type: 'group', group_id: 200 }));
  await bot.accept(event(mention('问题二'), { message_type: 'group', group_id: 200 }));
  assert.equal(bot.stats.throttled, 2); release(); await first;
});

test('mentions take priority over queued ordinary messages without interrupting an active response', async () => {
  const c = config(); c.access.groupTrigger = 'mention-or-random'; c.access.groupReplyChance = 100; c.chat.maxConcurrent = 1;
  const started = []; let release; const gate = new Promise(r => release = r);
  const bot = new Bot(c, { random: () => 0, model: async (_, messages) => {
    const text = messages.at(-1).content; started.push(text);
    if (text === '正在处理') await gate;
    return modelResult('好');
  }, send: async () => {} });
  const first = bot.accept(event('正在处理', { message_type: 'group', group_id: 200 }));
  await eventually(() => started.length === 1);
  const ordinary = bot.accept(event('普通排队', { message_type: 'group', group_id: 200, user_id: 101 }));
  const direct = bot.accept(event(mention('直接提问'), { message_type: 'group', group_id: 200, user_id: 102 }));
  await eventually(() => bot.jobs.length === 2);
  assert.deepEqual(started, ['正在处理']);
  release(); await Promise.all([first, ordinary, direct]);
  assert.deepEqual(started, ['正在处理', '直接提问', '普通排队']);
});
test('Responses extraction handles messages, refusal and multiple text blocks', () => {
  assert.equal(extractText({ output: [{ type: 'reasoning', content: [] }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '你好' }, { type: 'output_text', text: '世界' }] }] }), '你好\n世界');
  assert.equal(extractText({ output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: '无法协助' }] }] }), '无法协助');
});

test('keyword settings accept bounded percentages and nonempty aliases with backward-compatible defaults', () => {
  const c = config();
  for (const value of [0, 50, 100]) { c.access.groupKeywordReplyChance = value; assert.doesNotThrow(() => validate(c)); }
  for (const value of [-1, 101, 1.5, '50']) { c.access.groupKeywordReplyChance = value; assert.throws(() => validate(c)); }
  c.access.groupKeywordReplyChance = 50;
  for (const value of [[''], ['   '], [123], ['x'.repeat(65)], Array(51).fill('gpt'), 'gpt']) { c.access.groupKeywords = value; assert.throws(() => validate(c)); }
  c.access.groupKeywords = []; assert.doesNotThrow(() => validate(c));
  const old = config(); delete old.access.groupKeywords; delete old.access.groupKeywordReplyChance;
  const merged = merge(defaults(), old); assert.equal(merged.access.groupKeywordReplyChance, 50); assert.ok(merged.access.groupKeywords.includes('gpt'));
});

test('aliases match case and full-width variants and use the boosted probability boundary', async () => {
  const c = config(); c.access.groupTrigger = 'mention-or-random'; c.access.groupReplyChance = 10; c.access.groupKeywordReplyChance = 50;
  const sent = [], draws = [0.49, 0.49, 0.49, 0.5, 0.49, 0.05];
  const bot = new Bot(c, { random: () => draws.shift(), model: async (_, messages) => modelResult(messages.at(-1).content), send: async (_, text) => sent.push(text) });
  for (const text of ['gPt 你好', 'ＧＰＴ 在吗', '小橘来聊聊', 'ChatGPT 帮忙', '普通聊天', '其他闲聊']) await bot.accept(event(text, { message_type: 'group', group_id: 200 }));
  assert.deepEqual(sent, ['gPt 你好', 'ＧＰＴ 在吗', '小橘来聊聊', '其他闲聊']); assert.equal(draws.length, 0);
});

test('a custom alias list replaces defaults and an empty list disables the boost', async () => {
  const c = config(); c.access.groupTrigger = 'mention-or-random'; c.access.groupKeywords = ['小太阳'];
  const sent = [];
  const bot = new Bot(c, { random: () => 0.3, model: async (_, messages) => modelResult(messages.at(-1).content), send: async (_, text) => sent.push(text) });
  await bot.accept(event('小太阳你好', { message_type: 'group', group_id: 200 }));
  await bot.accept(event('gpt 你好', { message_type: 'group', group_id: 200 }));
  c.access.groupKeywords = [];
  await bot.accept(event('小太阳再聊聊', { message_type: 'group', group_id: 200 }));
  assert.deepEqual(sent, ['小太阳你好']);
});

test('keyword probability cannot lower the ordinary rate and mentions still bypass both probabilities', async () => {
  const c = config(); c.access.groupTrigger = 'mention-or-random'; c.access.groupReplyChance = 80; c.access.groupKeywordReplyChance = 50;
  let calls = 0;
  const bot = new Bot(c, { random: () => 0.7, model: async () => { calls++; return modelResult('好'); }, send: async () => {} });
  await bot.accept(event('gpt 你好', { message_type: 'group', group_id: 200 }));
  c.access.groupReplyChance = 0; c.access.groupKeywordReplyChance = 0;
  bot.random = () => { throw Error('mention should not draw'); };
  await bot.accept(event(mention('gpt 你好'), { message_type: 'group', group_id: 200 }));
  assert.equal(calls, 2);
});

test('a keyword reply explains aliases to the model without changing the saved persona or user text', async () => {
  const c = config(); c.access.groupTrigger = 'mention-or-random'; c.openai.systemPrompt = '你叫小橘，活泼开朗。';
  let received;
  const bot = new Bot(c, { random: () => 0.2, model: async (modelConfig, messages) => { received = { modelConfig, messages }; return modelResult('我在'); }, send: async () => {} });
  await bot.accept(event('GPT 你叫什么', { message_type: 'group', group_id: 200 }));
  assert.ok(received.modelConfig.openai.systemPrompt.startsWith(c.openai.systemPrompt));
  assert.match(received.modelConfig.openai.systemPrompt, /对你的称呼/);
  assert.equal(received.messages.at(-1).content, 'GPT 你叫什么');
  assert.equal(c.openai.systemPrompt, '你叫小橘，活泼开朗。');
});

test('keyword settings do not sample private chats or bypass blocked users and group allowlists', async () => {
  const c = config(); c.access.groupTrigger = 'mention-or-random'; c.access.groupKeywordReplyChance = 100; c.access.blockedUsers = ['101'];
  let calls = 0;
  const bot = new Bot(c, { random: () => { throw Error('ineligible messages should not draw'); }, model: async modelConfig => { assert.equal(modelConfig, c); calls++; return modelResult('好'); }, send: async () => {} });
  await bot.accept(event('GPT 私聊'));
  await bot.accept(event('GPT 群聊', { message_type: 'group', group_id: 201 }));
  await bot.accept(event('GPT 群聊', { message_type: 'group', group_id: 200, user_id: 101 }));
  assert.equal(calls, 1);
});
test('real HTTP model request uses Responses API, memory input and store:false', async () => {
  let received;
  const server = http.createServer(async (req, res) => { const chunks = []; for await (const p of req) chunks.push(p); received = { path: req.url, auth: req.headers.authorization, data: JSON.parse(Buffer.concat(chunks)) }; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '连接成功' }] }], usage: { input_tokens: 5, output_tokens: 2 } })); });
  const url = await listen(server);
  try { const c = config(); c.openai.baseUrl = url + '/v1/'; const result = await generate(c, [{ role: 'user', content: '你好' }]); assert.equal(result.text, '连接成功'); assert.equal(received.path, '/v1/responses'); assert.equal(received.auth, 'Bearer test-key'); assert.equal(received.data.store, false); assert.equal(received.data.model, c.openai.model); assert.equal(received.data.input[0].content, '你好'); assert.equal(received.data.tools, undefined); }
  finally { await close(server); }
});
test('upstream HTTP errors never expose upstream secrets in QQ replies', async () => {
  const server = http.createServer((req, res) => { req.resume(); res.writeHead(401); res.end('secret-diagnostic'); });
  const url = await listen(server);
  try { const c = config(); c.openai.baseUrl = url; let caught; try { await generate(c, []); } catch (e) { caught = e; } assert.equal(caught.status, 401); assert.ok(!userError(caught).includes('secret-diagnostic')); assert.equal(caught.message, 'http_error'); }
  finally { await close(server); }
});
test('deduplication prevents duplicate model calls and replies', async () => {
  let calls = 0; const sent = [];
  const bot = new Bot(config(), { model: async () => { calls++; return modelResult('hi'); }, send: async (e, text) => sent.push(text) });
  const e = event(); await Promise.all([bot.accept(e), bot.accept(e)]);
  assert.equal(calls, 1); assert.deepEqual(sent, ['hi']); assert.equal(bot.stats.replied, 1);
});
test('same-session messages run in order with prior assistant context', async () => {
  const inputs = [];
  const bot = new Bot(config(), { model: async (_, input) => { inputs.push(structuredClone(input)); await new Promise(r => setTimeout(r, 10)); return modelResult('reply ' + input.at(-1).content); }, send: async () => {} });
  await Promise.all([bot.accept(event('one')), bot.accept(event('two'))]);
  assert.deepEqual(inputs[1].map(x => x.content), ['one', 'reply one', 'two']);
  assert.equal(bot.pending, 0);
});
test('group histories are isolated by user and by group', async () => {
  const inputs = [];
  const c = config(); c.access.groups.push('201');
  const bot = new Bot(c, { model: async (_, input) => { inputs.push(input); return modelResult('ok'); }, send: async () => {} });
  await bot.accept(event(mention('a'), { message_type: 'group', group_id: 200 }));
  await bot.accept(event(mention('b'), { message_type: 'group', group_id: 200, user_id: 101 }));
  await bot.accept(event(mention('c'), { message_type: 'group', group_id: 201 }));
  assert.deepEqual(inputs.map(x => x.length), [1, 1, 1]);
});
test('/reset clears only its session; /help and /ping do not call GPT', async () => {
  const inputs = [], sent = [];
  const bot = new Bot(config(), { model: async (_, input) => { inputs.push(input); return modelResult('ok'); }, send: async (_, text) => sent.push(text) });
  for (const text of ['first', '/reset', '/ping', '/help', 'second']) await bot.accept(event(text));
  assert.deepEqual(inputs.map(x => x.length), [1, 1]); assert.equal(sent.length, 5);
});
test('history limits include zero history and character bounds', async () => {
  const c = config(); c.chat.historyTurns = 0;
  const inputs = []; const bot = new Bot(c, { model: async (_, input) => { inputs.push(input); return modelResult('ok'); }, send: async () => {} });
  await bot.accept(event('a')); await bot.accept(event('b')); assert.deepEqual(inputs.map(x => x.length), [1, 1]);
  c.chat.historyTurns = 10; c.chat.historyMaxChars = 5;
  assert.deepEqual(bot.trimHistory([{ role: 'user', content: 'long' }, { role: 'assistant', content: 'long' }]), []);
});
test('failed generation does not poison memory and later turns recover', async () => {
  let count = 0; const inputLengths = [], sent = [];
  const bot = new Bot(config(), { model: async (_, input) => { inputLengths.push(input.length); if (!count++) throw new ServiceError('http_error', 429); return modelResult('ok'); }, send: async (_, text) => sent.push(text) });
  await bot.accept(event('a')); await bot.accept(event('b'));
  assert.deepEqual(inputLengths, [1, 1]); assert.equal(bot.stats.errors, 1); assert.equal(bot.stats.replied, 1); assert.match(sent[0], /额度/);
});
test('a QQ send failure is not retried as a second message', async () => {
  let sends = 0;
  const bot = new Bot(config(), { model: async () => modelResult('ok'), send: async () => { sends++; throw new ServiceError('onebot_timeout'); } });
  await bot.accept(event()); assert.equal(sends, 1); assert.equal(bot.stats.replied, 0);
});
test('an HTTP transport error from QQ is classified separately and not retried', async () => {
  let sends = 0;
  const server = http.createServer((req, res) => { req.resume(); sends++; res.writeHead(503); res.end('gateway failure'); });
  const url = await listen(server), c = config(); c.onebot.mode = 'http'; c.onebot.httpUrl = url;
  const ob = new OneBot(c, () => {}); ob.start();
  try { const bot = new Bot(c, { model: async () => modelResult('ok'), send: (e, text) => ob.send(e, text) }); await bot.accept(event()); assert.equal(sends, 1); assert.equal(bot.stats.errors, 1); }
  finally { ob.stop(); await close(server); }
});
test('global concurrency and pending limits bound busy sessions', async () => {
  const c = config(); c.chat.maxConcurrent = 1; c.chat.maxPending = 2; c.access.privateUsers = ['101', '102'];
  let release; const gate = new Promise(r => release = r); let running = 0, peak = 0;
  const bot = new Bot(c, { model: async () => { running++; peak = Math.max(peak, running); await gate; running--; return modelResult('ok'); }, send: async () => {} });
  const a = bot.accept(event('a')), b = bot.accept(event('b', { user_id: 101 })); await bot.accept(event('c', { user_id: 102 }));
  assert.equal(bot.stats.throttled, 1); release(); await Promise.all([a, b]); assert.equal(peak, 1); assert.equal(bot.pending, 0);
});
test('per-session limits and cooldown prevent repeated requests', async () => {
  const c = config(); c.chat.maxPendingPerSession = 1;
  let release; const gate = new Promise(r => release = r);
  const bot = new Bot(c, { model: async () => { await gate; return modelResult('ok'); }, send: async () => {} });
  const first = bot.accept(event('a')); await bot.accept(event('b')); assert.equal(bot.stats.throttled, 1); release(); await first;
  c.chat.cooldownMs = 60000; await bot.accept(event('c')); assert.equal(bot.stats.throttled, 2);
});
test('oversized input is rejected before spending model tokens', async () => {
  let calls = 0; const sent = []; const c = config(); c.chat.maxInputChars = 100;
  const bot = new Bot(c, { model: async () => { calls++; return modelResult('ok'); }, send: async (_, text) => sent.push(text) });
  await bot.accept(event('x'.repeat(101))); assert.equal(calls, 0); assert.match(sent[0], /消息太长/);
});
test('HTTP OneBot sender uses text segments, authenticates, splits Unicode and checks retcode', async () => {
  const sent = []; let fail = false;
  const server = http.createServer(async (req, res) => { const chunks = []; for await (const p of req) chunks.push(p); sent.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) }); res.end(JSON.stringify(fail ? { status: 'failed', retcode: 100 } : { status: 'ok', retcode: 0, data: { message_id: 1 } })); });
  const url = await listen(server); const c = config(); c.onebot.mode = 'http'; c.onebot.httpUrl = url; c.onebot.accessToken = 'test-qq-token'; c.chat.chunkChars = 3;
  const ob = new OneBot(c, () => {}); ob.start();
  try { await ob.send(event(), '😀😀😀[CQ:at,qq=all]'); assert.equal(sent[0].body.message[0].data.text, '😀😀😀'); assert.equal(sent[0].auth, 'Bearer test-qq-token'); assert.equal(sent[0].path, '/send_private_msg'); assert.ok(sent.every(s => s.body.message.every(m => m.type === 'text'))); fail = true; await assert.rejects(ob.send(event(), 'x'), /onebot_action_failed/); }
  finally { ob.stop(); await close(server); }
});
test('signed HTTP events return immediately, invoke GPT and send through OneBot HTTP', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gpt-qq-server-')); const c = config(); c.onebot.mode = 'http'; c.onebot.eventSecret = 'a-long-test-event-secret'; c.openai.apiKey = 'hidden-key';
  const sent = []; let release; const gate = new Promise(r => release = r);
  let modelRequests = 0;
  const gateway = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks));
    if (req.url === '/v1/responses') {
      modelRequests++; assert.equal(payload.input[0].content, '你好'); await gate;
      res.end(JSON.stringify({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'HTTP 回路正常' }] }] }));
    } else if (req.url === '/send_private_msg') {
      assert.equal(payload.user_id, 100); sent.push(payload.message[0].data.text);
      res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 } }));
    } else { res.writeHead(404); res.end(); }
  });
  const gatewayUrl = await listen(gateway); c.openai.baseUrl = gatewayUrl + '/v1'; c.onebot.httpUrl = gatewayUrl;
  let bot; const ob = new OneBot(c, e => { void bot.accept(e); }); ob.start();
  bot = new Bot(c, { send: (e, text) => ob.send(e, text) });
  const server = createServer({ config: c, token: 'admin-token', bot, onebot: ob, root: dir }); const url = await listen(server);
  try {
    const page = await (await fetch(url + '/')).text(); assert.match(page, /让 GPT 来 QQ 聊天/); new Script(page.match(/<script>([\s\S]*?)<\/script>/)[1]);
    assert.equal((await fetch(url + '/api/status')).status, 401);
    const headers = { 'X-Admin-Token': 'admin-token', 'Content-Type': 'application/json' };
    const safe = await (await fetch(url + '/api/config', { headers })).text(); assert.ok(!safe.includes('hidden-key')); assert.ok(!safe.includes(c.onebot.eventSecret));
    assert.equal((await fetch(url + '/api/config', { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: '{}' })).status, 403);
    // Node fetch rewrites Host, so use the low-level HTTP client to test rebinding.
    const badHost = await new Promise((resolve, reject) => { const req = http.request(url + '/api/status', { headers: { ...headers, Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); req.end(); });
    assert.equal(badHost, 403);
    const raw = JSON.stringify(event());
    assert.equal((await fetch(url + '/onebot/events', { method: 'POST', body: raw })).status, 401);
    const signature = 'sha1=' + createHmac('sha1', c.onebot.eventSecret).update(raw).digest('hex');
    const response = await fetch(url + '/onebot/events', { method: 'POST', headers: { 'X-Signature': signature }, body: raw }); assert.equal(response.status, 204); assert.equal(sent.length, 0);
    release(); await bot.drain(); assert.deepEqual(sent, ['HTTP 回路正常']); assert.equal(modelRequests, 1);
    const saved = await fetch(url + '/api/config', { method: 'POST', headers, body: JSON.stringify({ openai: { apiKey: '', model: 'my-gpt' }, access: { groups: ['300'], groupTrigger: 'mention-or-random', groupReplyChance: 10, groupKeywordReplyChance: 50, groupKeywords: ['gpt', '小橘'] } }) });
    assert.equal(saved.status, 200); const stored = JSON.parse(readFileSync(join(dir, 'config.json'))); assert.equal(stored.openai.apiKey, 'hidden-key'); assert.equal(stored.openai.model, 'my-gpt'); assert.equal(c.openai.model, 'gpt-4.1-mini');
    assert.equal(stored.access.groupTrigger, 'mention-or-random'); assert.equal(stored.access.groupReplyChance, 10); assert.equal(c.access.groupTrigger, 'mention');
    assert.equal(stored.access.groupKeywordReplyChance, 50); assert.deepEqual(stored.access.groupKeywords, ['gpt', '小橘']);
    await fetch(url + '/api/config', { method: 'POST', headers, body: JSON.stringify({ openai: { apiKey: 'new-hidden-key' } }) });
    await fetch(url + '/api/config', { method: 'POST', headers, body: JSON.stringify({ openai: { apiKey: '' }, access: { ownerQQ: '101' } }) });
    const savedAgain = JSON.parse(readFileSync(join(dir, 'config.json'))); assert.equal(savedAgain.openai.apiKey, 'new-hidden-key'); assert.equal(savedAgain.openai.model, 'my-gpt');
    assert.equal((await fetch(url + '/api/config', { method: 'POST', headers, body: '{broken' })).status, 400);
    assert.equal((await fetch(url + '/api/config', { method: 'POST', headers, body: JSON.stringify({ chat: { maxConcurrent: 0 } }) })).status, 400);
  } finally { release(); bot.stop(); ob.stop(); await bot.drain(); await close(server); await close(gateway); rmSync(dir, { recursive: true, force: true }); }
});

// Minimal test-only RFC6455 fixture. The production app uses Node's native client.
function wsFrame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  const header = payload.length < 126 ? Buffer.from([0x81, payload.length]) : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255]);
  return Buffer.concat([header, payload]);
}
test('native WebSocket performs token handshake, event input and echo-matched QQ replies', async () => {
  const calls = [], sockets = []; let upgradeUrl;
  const server = http.createServer();
  server.on('upgrade', (req, socket) => {
    sockets.push(socket); upgradeUrl = req.url;
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 15; let length = buffer[1] & 127; let offset = 2;
        if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
        if (length === 127) { socket.destroy(); return; }
        const masked = Boolean(buffer[1] & 128); const total = offset + (masked ? 4 : 0) + length;
        if (buffer.length < total) return;
        const mask = masked ? buffer.subarray(offset, offset + 4) : null; offset += masked ? 4 : 0;
        const payload = Buffer.from(buffer.subarray(offset, offset + length)); buffer = buffer.subarray(total);
        if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        if (opcode === 8) { socket.end(Buffer.from([0x88, 0])); return; }
        if (opcode !== 1) continue;
        const packet = JSON.parse(payload); calls.push(packet);
        socket.write(wsFrame({ status: 'ok', retcode: 0, echo: packet.echo, data: packet.action === 'get_login_info' ? { user_id: 999, nickname: 'fixture' } : { message_id: 123 } }));
        if (packet.action === 'get_login_info') socket.write(wsFrame(event('WebSocket test')));
      }
    });
  });
  const url = await listen(server); const c = config(); c.onebot.wsUrl = url.replace('http:', 'ws:'); c.onebot.accessToken = 'token +/测试';
  let bot; const ob = new OneBot(c, e => { void bot.accept(e); }); bot = new Bot(c, { send: (e, text) => ob.send(e, text), model: async () => modelResult('WebSocket 回复成功') }); ob.start();
  try { await eventually(() => bot.stats.replied === 1); assert.equal(new URL(upgradeUrl, url).searchParams.get('access_token'), c.onebot.accessToken); const sent = calls.find(x => x.action === 'send_private_msg'); assert.equal(sent.params.user_id, 100); assert.equal(sent.params.message[0].data.text, 'WebSocket 回复成功'); assert.equal(ob.selfId, '999'); }
  finally { bot.stop(); ob.stop(); for (const s of sockets) s.destroy(); await close(server); }
});
