import { generate, userError } from './provider.js';

const validId = x => /^\d+$/.test(String(x)) && Number.isSafeInteger(Number(x)) && Number(x) > 0;
const decode = text => text.replaceAll('&#91;', '[').replaceAll('&#93;', ']').replaceAll('&#44;', ',').replaceAll('&amp;', '&');
export function parseMessage(message, selfId) {
  let mentioned = false; let text = '';
  if (Array.isArray(message)) {
    for (const segment of message) {
      if (segment?.type === 'text' && typeof segment.data?.text === 'string') text += segment.data.text;
      if (segment?.type === 'at' && selfId && String(segment.data?.qq) === String(selfId)) mentioned = true;
    }
  } else if (typeof message === 'string') {
    text = message.replace(/\[CQ:([^,\]]+)((?:,[^\]]*)?)\]/g, (_, type, fields) => {
      if (type === 'at') {
        const match = fields.match(/(?:^|,)qq=([^,]+)/);
        if (selfId && match && decode(match[1]) === String(selfId)) mentioned = true;
      }
      return '';
    });
    text = decode(text);
  }
  return { text: text.trim(), mentioned };
}
export function routeEvent(event, config) {
  if (event?.post_type !== 'message' || !['private', 'group'].includes(event.message_type)) return null;
  if (!validId(event.user_id) || !validId(event.self_id)) return null;
  if (String(event.user_id) === String(event.self_id)) return null;
  if (config.onebot.botQQ && config.onebot.botQQ !== String(event.self_id)) return null;
  const user = String(event.user_id); const group = event.message_type === 'group';
  if (config.access.blockedUsers.includes(user)) return null;
  if (group) {
    if (!validId(event.group_id) || !config.access.groups.includes(String(event.group_id))) return null;
  } else if (user !== config.access.ownerQQ && !config.access.privateUsers.includes(user)) return null;
  let { text, mentioned } = parseMessage(event.message, event.self_id);
  const prefix = config.access.prefix;
  const prefixed = text === prefix || text.startsWith(prefix + ' ') || text.startsWith(prefix + '\n');
  if (group && config.access.groupTrigger === 'mention' && !mentioned) return null;
  if (group && config.access.groupTrigger === 'prefix' && !prefixed) return null;
  if (prefixed) text = text.slice(prefix.length).trim();
  if (!text) return null;
  // In a group, each member has a separate history, including /reset.
  const key = `${event.self_id}:${group ? 'g:' + event.group_id + ':u' : 'p'}:${user}`;
  return { key, text, event };
}
export class Bot {
  constructor(config, { send, model = generate, log = () => {} } = {}) {
    this.config = config; this.send = send; this.model = model; this.log = log;
    this.sessions = new Map(); this.seen = new Map(); this.active = 0; this.pending = 0;
    this.jobs = []; this.stopped = false; this.contextEpoch = 0;
    this.stats = { received: 0, accepted: 0, replied: 0, ignored: 0, throttled: 0, errors: 0, inputTokens: 0, outputTokens: 0 };
  }
  accept(event) {
    if (this.stopped) return Promise.resolve();
    this.stats.received++;
    const routed = routeEvent(event, this.config);
    if (!routed) { this.stats.ignored++; return Promise.resolve(); }
    routed.epoch = this.contextEpoch;
    const now = Date.now();
    for (const [id, at] of this.seen) { if (now - at > 600000) this.seen.delete(id); else break; }
    if (event.message_id !== undefined && event.message_id !== null) {
      if (!['number', 'string'].includes(typeof event.message_id)) return Promise.resolve();
      const id = `${routed.key}:${event.message_id}`;
      if (this.seen.has(id)) { this.stats.ignored++; return Promise.resolve(); }
      this.seen.set(id, now);
      if (this.seen.size > 10000) this.seen.delete(this.seen.keys().next().value);
    }
    for (const [key, session] of this.sessions) {
      if (!session.pending && now - session.lastUsed > this.config.chat.sessionTtlMinutes * 60000) this.sessions.delete(key);
    }
    let s = this.sessions.get(routed.key);
    if (!s) {
      if (this.sessions.size >= this.config.chat.maxSessions) {
        const old = [...this.sessions].filter(([, item]) => !item.pending).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
        if (!old) { this.stats.throttled++; return Promise.resolve(); }
        this.sessions.delete(old[0]);
      }
      s = { history: [], pending: 0, lastAccepted: 0, lastUsed: now, tail: Promise.resolve() };
      this.sessions.set(routed.key, s);
    }
    if (this.pending >= this.config.chat.maxPending || s.pending >= this.config.chat.maxPendingPerSession || now - s.lastAccepted < this.config.chat.cooldownMs) {
      this.stats.throttled++; return Promise.resolve();
    }
    s.lastAccepted = now; s.lastUsed = now; s.pending++; this.pending++; this.stats.accepted++;
    const job = s.tail.then(() => this.slot(() => this.handle(routed, s))).catch(() => {
      this.stats.errors++; this.log('error', '会话处理失败');
    }).finally(() => { s.pending--; this.pending--; s.lastUsed = Date.now(); });
    s.tail = job;
    return job;
  }
  slot(fn) {
    return new Promise((resolve, reject) => { this.jobs.push({ fn, resolve, reject }); this.pump(); });
  }
  pump() {
    while (this.active < this.config.chat.maxConcurrent && this.jobs.length) {
      const job = this.jobs.shift(); this.active++;
      Promise.resolve().then(job.fn).then(job.resolve, job.reject).finally(() => { this.active--; this.pump(); });
    }
  }
  trimHistory(messages) {
    const max = this.config.chat.historyTurns * 2;
    const history = max ? messages.slice(-max) : [];
    while (history.length && history.reduce((n, m) => n + m.content.length, 0) > this.config.chat.historyMaxChars) history.splice(0, 2);
    return history;
  }
  async handle({ event, text, epoch }, session) {
    if (this.stopped || epoch !== this.contextEpoch) return;
    try {
      if (text === '/reset') {
        session.history = []; await this.send(event, '已清空你在当前会话中的聊天记忆。'); return;
      }
      if (text === '/help') {
        await this.send(event, '直接发送文字即可聊天。\n/reset 清空当前聊天记忆\n/ping 检查机器人\n/help 查看帮助\n群内按管理员设置使用 @ 或前缀触发；暂不识别图片与语音。'); return;
      }
      if (text === '/ping') { await this.send(event, '机器人在线，当前模型：' + this.config.openai.model); return; }
      if (text.length > this.config.chat.maxInputChars) { await this.send(event, `消息太长，请控制在 ${this.config.chat.maxInputChars} 个字符内。`); return; }
      const input = [...this.trimHistory(session.history), { role: 'user', content: text }];
      const result = await this.model(this.config, input);
      this.stats.inputTokens += Number(result.usage?.input_tokens) || 0;
      this.stats.outputTokens += Number(result.usage?.output_tokens) || 0;
      if (this.stopped || epoch !== this.contextEpoch) return;
      const answer = result.text + (result.incomplete ? '\n[达到本次输出上限]' : '');
      const visible = Array.from(answer).slice(0, this.config.chat.maxReplyChars).join('');
      await this.send(event, answer);
      session.history = this.trimHistory([...input, { role: 'assistant', content: visible }]);
      this.stats.replied++;
      this.log('info', '完成一次 GPT 回复');
    } catch (error) {
      this.stats.errors++;
      // Never include raw upstream errors, prompts, or credentials in logs/replies.
      const code = typeof error.code === 'string' && /^[a-z_]+$/.test(error.code) ? error.code : 'unknown';
      this.log('error', `请求失败：${code}${Number.isInteger(error.status) && error.status ? ' / HTTP ' + error.status : ''}`);
      if (!code.startsWith('onebot_') && !this.stopped && epoch === this.contextEpoch) {
        try { await this.send(event, userError(error)); } catch { this.log('error', 'QQ 错误提示发送失败'); }
      }
    }
  }
  async drain() { await Promise.all([...this.sessions.values()].map(s => s.tail)); }
  invalidateSessions() { this.contextEpoch++; for (const session of this.sessions.values()) session.history = []; }
  stop() { this.stopped = true; }
}
