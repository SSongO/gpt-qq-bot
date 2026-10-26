import http from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT, safeConfig, validate, merge, atomicWrite } from './config.js';
import { generate, userError } from './provider.js';

export function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
async function body(req, limit = 262144) {
  const chunks = []; let length = 0;
  for await (const part of req) {
    length += part.length;
    if (length > limit) { const e = new Error('请求过大'); e.status = 413; throw e; }
    chunks.push(part);
  }
  return Buffer.concat(chunks);
}
export function createServer({ config, token, bot, onebot, logs = [], root = ROOT, onRestart = null, onStop = null, planAuth = null }) {
  let testingModel = false, testingQQ = false;
  let savedConfig = config;
  const html = readFileSync(resolve(ROOT, 'public/index.html'));
  const server = http.createServer(async (req, res) => {
    const respond = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(value === undefined ? '' : JSON.stringify(value));
    };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const port = server.address()?.port;
      if (![ `127.0.0.1:${port}`, `localhost:${port}` ].includes(req.headers.host)) return respond(403, { error: '仅限本机访问' });
      const path = new URL(req.url, 'http://localhost').pathname;
      if (path === '/' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); return; }
      if (path === '/auth/callback' && req.method === 'GET' && planAuth) {
        let message;
        try { const status = await planAuth.callback(new URL(req.url, 'http://localhost').searchParams); bot.invalidateSessions(); message = status.planEnabled ? 'ChatGPT 登录成功，订阅额度已授权。请返回控制台刷新模型列表，保存配置后重启生效。' : '登录成功，但尚未授权订阅额度。请返回控制台重新授权。'; }
        catch { message = 'ChatGPT 授权未完成或验证失败。请返回控制台重新点击登录。'; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>ChatGPT 登录</title><body style="font:18px/1.8 system-ui;padding:50px"><h1>GPT QQ Bot</h1><p>' + message + '</p><p>可以关闭此页面。</p></body></html>'); return;
      }
      if (path === '/onebot/events' && req.method === 'POST') {
        if (config.onebot.mode !== 'http') return respond(409, { error: '尚未启用 HTTP 上报模式' });
        const raw = await body(req);
        const expected = 'sha1=' + createHmac('sha1', config.onebot.eventSecret).update(raw).digest('hex');
        if (!config.onebot.eventSecret || !sameSecret(req.headers['x-signature'], expected)) return respond(401, { error: '签名校验失败' });
        let event; try { event = JSON.parse(raw.toString('utf8')); } catch { return respond(400, { error: '无效 JSON' }); }
        if (!event || typeof event !== 'object' || Array.isArray(event)) return respond(400, { error: '无效事件' });
        onebot.receive(event);
        return respond(204);
      }
      if (!path.startsWith('/api/')) return respond(404, { error: '未找到' });
      if (!sameSecret(req.headers['x-admin-token'], token)) return respond(401, { error: '请填写启动窗口中的控制台令牌' });
      if (req.headers.origin && ![`http://127.0.0.1:${port}`, `http://localhost:${port}`].includes(req.headers.origin)) return respond(403, { error: '来源无效' });
      if (path === '/api/status' && req.method === 'GET') return respond(200, {
        application: 'gpt-qq-bot', processId: process.pid, managed: Boolean(onRestart),
        mode: config.onebot.mode, connected: onebot.connected, selfId: onebot.selfId,
        lastEventAt: onebot.lastEventAt, model: config.openai.model, sessions: bot.sessions.size,
        pending: bot.pending, active: bot.active, stats: bot.stats, logs: logs.slice(-60)
      });
      if (path === '/api/config' && req.method === 'GET') return respond(200, safeConfig(config));
      if (path === '/api/chatgpt/status' && req.method === 'GET') return respond(200, planAuth?.status() ?? { signedIn: false, planEnabled: false, profiles: [] });
      if (req.method !== 'POST') return respond(405, { error: '方法不支持' });
      const raw = await body(req, 65536);
      let data; try { data = JSON.parse(raw.toString('utf8') || '{}'); } catch { return respond(400, { error: '无效 JSON' }); }
      if (path.startsWith('/api/chatgpt/')) {
        if (!planAuth) return respond(409, { error: '当前启动方式未启用 ChatGPT 登录' });
        try {
          if (path === '/api/chatgpt/login') return respond(200, planAuth.begin(port, data?.profileId || null, data?.newAccount === true));
          if (path === '/api/chatgpt/select') { const selected = planAuth.select(data?.profileId); bot.invalidateSessions(); return respond(200, selected); }
          if (path === '/api/chatgpt/models') return respond(200, { models: await planAuth.models() });
          if (path === '/api/chatgpt/welcome') { planAuth.welcome(); return respond(200, { ok: true }); }
          if (path === '/api/chatgpt/logout') { bot.invalidateSessions(); return respond(200, await planAuth.logout()); }
        } catch (e) {
          const message = e.code === 'chatgpt_network_error' ? '无法连接 OpenAI 登录服务，请检查网络。' : e.code === 'chatgpt_invalid_state' ? '登录请求已过期，请重新登录。' : userError(e);
          return respond(400, { error: message });
        }
      }
      if (path === '/api/restart') {
        if (!onRestart) return respond(409, { error: '请在原启动窗口停止程序后重新启动。' });
        respond(200, { ok: true, port: savedConfig.port });
        setTimeout(onRestart, 150); return;
      }
      if (path === '/api/stop') {
        if (!onStop) return respond(409, { error: '当前启动方式不支持控制台停止。' });
        respond(200, { ok: true }); setTimeout(onStop, 150); return;
      }
      if (path === '/api/config') {
        if (!data || typeof data !== 'object' || Array.isArray(data)) return respond(400, { error: '配置必须是对象' });
        // Empty secret fields mean keep existing; deleting secrets requires editing config.json.
        if (data.openai && data.openai.apiKey === '') delete data.openai.apiKey;
        for (const k of ['accessToken', 'eventSecret']) if (data.onebot?.[k] === '') delete data.onebot[k];
        let next; try { next = validate(merge(savedConfig, data)); } catch (e) { return respond(400, { error: e.message }); }
        atomicWrite(resolve(root, 'config.json'), JSON.stringify(next, null, 2) + '\n');
        savedConfig = next;
        return respond(200, { ok: true, restartRequired: true, message: onRestart ? '已保存。点击「重启生效」使用新配置。重启会清空聊天记忆。' : '已保存。关闭启动窗口后重新运行 start.cmd 生效。' });
      }
      if (path === '/api/test-model') {
        if (testingModel) return respond(429, { error: '正在测试，请稍候' });
        testingModel = true;
        try {
          const result = await generate(config, [{ role: 'user', content: '请只回复：连接成功' }]);
          return respond(200, { ok: true, text: result.text.slice(0, 500), usage: result.usage });
        } catch (error) { return respond(502, { error: userError(error) }); }
        finally { testingModel = false; }
      }
      if (path === '/api/test-qq') {
        if (testingQQ) return respond(429, { error: '正在测试，请稍候' });
        testingQQ = true;
        try {
          const result = await onebot.call('get_login_info');
          onebot.selfId = String(result.user_id);
          return respond(200, { ok: true, userId: String(result.user_id), nickname: String(result.nickname ?? '') });
        } catch { return respond(502, { error: 'QQ 连接失败，请检查 OneBot 服务、地址、模式和 Access Token。' }); }
        finally { testingQQ = false; }
      }
      return respond(404, { error: '未找到' });
    } catch (e) {
      if (!res.headersSent) respond(e.status ?? 500, { error: e.status === 413 ? '请求过大' : '服务器无法处理请求' });
      else res.end();
    }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  return server;
}
