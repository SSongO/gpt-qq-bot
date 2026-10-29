import test from 'node:test';
import assert from 'node:assert/strict';
import { defaults, validate } from '../src/config.js';
import { Bot } from '../src/bot.js';
import { MediaResolver, mediaSegments, normalizeImage, safeImageRef, safeImageUrl, imageBytes } from '../src/media.js';
import { generateWithPlan } from '../src/provider.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/nvUAAAAASUVORK5CYII=', 'base64');
const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const imagePart = normalizeImage(png);
const config = () => { const c = defaults(); c.access.ownerQQ = '100'; c.access.groups = ['200', '201']; c.chat.cooldownMs = 0; c.access.groupTrigger = 'mention'; return c; };
let sequence = 0;
const event = (message, extra = {}) => ({ post_type: 'message', message_type: 'group', self_id: 999, user_id: 100, group_id: 200, message_id: ++sequence, message, ...extra });
const at = text => [{ type: 'at', data: { qq: '999' } }, { type: 'text', data: { text } }];
const result = text => ({ text, usage: {} });

test('media parsing preserves image and sticker references from arrays and CQ strings', () => {
  const parsed = mediaSegments('[CQ:image,file=x.png,url=https://gchat.qpic.cn/a?a=1&#44;b=2][CQ:mface,emoji_id=0123456789abcdef][CQ:face,id=14]');
  assert.equal(parsed.images.length, 2); assert.equal(parsed.images[0].url, 'https://gchat.qpic.cn/a?a=1,b=2'); assert.equal(parsed.images[1].sticker, true); assert.match(parsed.faces[0], /14/);
  assert.deepEqual(mediaSegments([null, { type: 'image', data: null }]).images[0].file, '');
});
test('image sources reject local paths, credentials, lookalike hosts and internal URLs', () => {
  for (const url of ['file:///C:/secret.png', 'http://127.0.0.1/x', 'https://gchat.qpic.cn.evil.test/a', 'https://user:pass@gchat.qpic.cn/a', 'https://gchat.qpic.cn:8888/a']) assert.equal(safeImageUrl(url), null);
  assert.ok(safeImageUrl('https://multimedia.nt.qq.com/a'));
  for (const ref of ['../../secret', 'C:\\secret.png', 'https://localhost/a', 'base64://abcd', 'a..png']) assert.equal(safeImageRef(ref), false);
  assert.equal(safeImageRef('ABC123.png'), true);
});
test('image normalization accepts PNG and static GIF and removes later GIF frames', () => {
  assert.match(normalizeImage(png).image_url, /^data:image\/png;base64,/);
  const single = normalizeImage(gif); assert.match(single.image_url, /^data:image\/gif;base64,/);
  const start = gif.indexOf(0x2c); const animated = Buffer.concat([gif.subarray(0, -1), gif.subarray(start, -1), Buffer.from([0x3b])]);
  assert.equal(normalizeImage(animated).image_url, single.image_url);
  assert.throws(() => normalizeImage(Buffer.from('<svg/>')), /image_invalid/);
  assert.throws(() => normalizeImage(png, 10), /image_too_large/);
  const huge = Buffer.from(png); huge.writeUInt32BE(100000, 16); huge.writeUInt32BE(100000, 20); assert.throws(() => normalizeImage(huge), /image_too_large/);
});
test('gateway image resolution supports cache data, signed QQ URLs and market sticker fallback', async () => {
  const c = config(); const urls = [], calls = [];
  const resolver = new MediaResolver(c, async (action, params) => { calls.push({ action, params }); return { base64: png.toString('base64') }; }, { fetchImpl: async url => { urls.push(url); return new Response(png); } });
  const cached = await resolver.resolve([{ file: 'x.png' }]); assert.equal(cached.parts.length, 1); assert.equal(calls[0].action, 'get_image'); assert.equal(urls.length, 0);
  const sticker = await resolver.resolve([{ file: '', sticker: true, emojiId: '0123456789abcdef' }]); assert.equal(sticker.parts.length, 1); assert.match(urls[0], /gxh\.vip\.qq\.com/);
});
test('APNG animation chunks are removed while preserving the default PNG image', () => {
  const animation = Buffer.alloc(20); animation.writeUInt32BE(8); animation.write('acTL', 4);
  const animated = Buffer.concat([png.subarray(0, 33), animation, png.subarray(33)]);
  assert.equal(normalizeImage(animated).image_url, normalizeImage(png).image_url);
});
test('animated WebP becomes a standalone first frame and excludes the animation container', () => {
  const vp8l = Buffer.from('UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=', 'base64');
  const subimage = vp8l.subarray(12), frame = Buffer.concat([Buffer.alloc(16), subimage]);
  const anmf = Buffer.alloc(8); anmf.write('ANMF'); anmf.writeUInt32LE(frame.length, 4);
  const payload = Buffer.concat([Buffer.from('WEBP'), anmf, frame, Buffer.alloc(frame.length % 2)]);
  const head = Buffer.alloc(8); head.write('RIFF'); head.writeUInt32LE(payload.length, 4);
  const normalized = normalizeImage(Buffer.concat([head, payload]));
  const bytes = Buffer.from(normalized.image_url.split(',')[1], 'base64');
  assert.equal(bytes.toString('ascii', 12, 16), 'VP8X'); assert.equal(bytes.includes(Buffer.from('ANMF')), false); assert.ok(bytes.includes(subimage));
});
test('downloads validate redirect targets and enforce actual streamed byte limits', async () => {
  const c = config(); let calls = 0;
  const redirect = new MediaResolver(c, async () => null, { fetchImpl: async () => { calls++; return new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/secret' } }); } });
  await assert.rejects(redirect.download('https://gchat.qpic.cn/a'), /image_download_failed/); assert.equal(calls, 1);
  c.vision.maxImageBytes = 64;
  const large = new MediaResolver(c, async () => null, { fetchImpl: async () => new Response(png) });
  await assert.rejects(large.download('https://gchat.qpic.cn/a'), /image_too_large/);
});
test('failed or excess pictures are reported while valid pictures remain available', async () => {
  const c = config(); c.vision.maxImages = 1;
  const resolver = new MediaResolver(c, async () => ({ base64: png.toString('base64') }));
  const images = await resolver.resolve([{ file: 'x.png' }, { file: 'y.png' }]); assert.equal(images.parts.length, 1); assert.equal(images.skipped, 1);
  const failed = await resolver.resolve([{ file: '../invalid' }]); assert.equal(failed.failed, 1);
});

test('a successful reply opens a timed, limited same-user group conversation', async () => {
  const c = config(); c.chat.continuationTurns = 2; let time = 1000000, calls = 0;
  const bot = new Bot(c, { now: () => time, model: async () => { calls++; return result('好'); }, send: async () => {} });
  await bot.accept(event(at('开始'))); await bot.accept(event('第二轮')); await bot.accept(event('第三轮')); await bot.accept(event('超过轮数'));
  assert.equal(calls, 3);
  await bot.accept(event(at('重新开始'))); time += 180001; await bot.accept(event('超过时间'));
  assert.equal(calls, 4);
});
test('a conversation continues through mixed-mode probability and cooldown without affecting other people or groups', async () => {
  const c = config(); c.access.groupTrigger = 'mention-or-random'; c.chat.cooldownMs = 60000; let calls = 0;
  const bot = new Bot(c, { random: () => 0.99, model: async () => { calls++; return result('好'); }, send: async () => {} });
  await bot.accept(event(at('开始'))); await bot.accept(event('紧接着继续'));
  await bot.accept(event('别人聊天', { user_id: 101 })); await bot.accept(event('另一个群', { group_id: 201 }));
  assert.equal(calls, 2);
});
test('end, reset, natural closing and account changes stop the continuation window', async () => {
  for (const ending of ['/end', '/reset', '晚安', 'account-change']) {
    const c = config(); let calls = 0;
    const bot = new Bot(c, { model: async () => { calls++; return result('好'); }, send: async () => {} });
    await bot.accept(event(at('开始')));
    if (ending === 'account-change') bot.invalidateSessions(); else await bot.accept(event(ending));
    const before = calls; await bot.accept(event('还继续吗')); assert.equal(calls, before);
  }
});
test('failed replies do not open a conversation and access restrictions still apply to followups', async () => {
  const c = config(); let calls = 0;
  const bot = new Bot(c, { model: async () => { calls++; throw Error('offline'); }, send: async () => {} });
  await bot.accept(event(at('开始'))); await bot.accept(event('后续')); assert.equal(calls, 1);
  bot.model = async () => { calls++; return result('好'); };
  await bot.accept(event(at('开始'))); c.access.blockedUsers = ['100']; await bot.accept(event('被禁用后')); assert.equal(calls, 2);
});
test('pictures are downloaded only after a message is accepted and stay in followup context', async () => {
  const c = config(); const inputs = []; let loads = 0;
  const bot = new Bot(c, { resolveMedia: async () => { loads++; return { parts: [imagePart], failed: 0, skipped: 0 }; }, model: async (_, messages) => { inputs.push(messages); return result('图片里有颜色'); }, send: async () => {} });
  const picture = [{ type: 'image', data: { file: 'x.png' } }];
  await bot.accept(event(picture)); assert.equal(loads, 0);
  await bot.accept(event([...at('看看图'), ...picture])); await bot.accept(event('图里左边是什么？'));
  assert.equal(loads, 1); assert.equal(inputs[0][0].content[1].type, 'input_image'); assert.ok(imageBytes(inputs[1]) > 0);
});
test('image-only failures cannot become fabricated visual answers and account changes during a download discard the result', async () => {
  const c = config(); let calls = 0; const sent = [];
  const bot = new Bot(c, { resolveMedia: async () => ({ parts: [], failed: 1, skipped: 0 }), model: async () => { calls++; return result('不应该调用'); }, send: async (_, text) => sent.push(text) });
  await bot.accept(event([...at(''), { type: 'image', data: { file: 'x.png' } }]));
  assert.equal(calls, 0); assert.match(sent[0], /没能读取/);
  let release; bot.resolveMedia = async () => new Promise(r => release = r);
  const work = bot.accept(event([...at('看图'), { type: 'image', data: { file: 'x.png' } }]));
  while (!release) await new Promise(r => setTimeout(r, 1));
  bot.invalidateSessions(); release({ parts: [imagePart], failed: 0, skipped: 0 }); await work; assert.equal(calls, 0);
});
test('image history observes both per-session count and the global byte budget', async () => {
  const c = config(); c.vision.historyImages = 1; c.vision.maxHistoryBytes = 0;
  const bot = new Bot(c, { resolveMedia: async () => ({ parts: [imagePart, imagePart], failed: 0, skipped: 0 }), model: async () => result('已看图'), send: async () => {} });
  await bot.accept(event([...at('图'), { type: 'image', data: { file: 'x.png' } }]));
  assert.equal(imageBytes([...bot.sessions.values()][0].history), 0);
});
test('the subscription transport sends image content and full context through the existing Responses contract', async () => {
  let body;
  const input = [{ role: 'user', content: [{ type: 'input_text', text: '看图' }, imagePart] }];
  const reply = await generateWithPlan(config(), input, { planAuth: { accessToken: async () => 'fixture' }, fetchImpl: async (_, options) => {
    body = JSON.parse(options.body); return new Response('data: ' + JSON.stringify({ type: 'response.completed', response: { output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '看到了' }] }] } }) + '\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  } });
  assert.equal(body.input[0].content[1].type, 'input_image'); assert.equal(body.stream, true); assert.equal(body.store, false); assert.equal(reply.text, '看到了');
});
test('vision and continuation settings reject invalid bounds', () => {
  for (const patch of [{ vision: { enabled: 'true' } }, { vision: { maxImages: 0 } }, { chat: { continuationSeconds: -1 } }, { chat: { continuationTurns: 21 } }]) {
    const c = config(); for (const [section, fields] of Object.entries(patch)) Object.assign(c[section], fields); assert.throws(() => validate(c));
  }
});
