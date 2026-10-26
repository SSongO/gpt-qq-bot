import { randomUUID } from 'node:crypto';
import { requestJson, ServiceError } from './provider.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export class OneBot {
  constructor(config, onEvent, log = () => {}) {
    this.config = config; this.onEvent = onEvent; this.log = log;
    this.pending = new Map(); this.connected = false; this.stopped = true;
    this.lastEventAt = null; this.selfId = null; this.reconnects = 0;
    this.activeSends = new Set();
  }
  start() {
    this.stopped = false;
    if (this.config.onebot.mode === 'websocket') this.connect();
  }
  connect() {
    if (this.stopped) return;
    const u = new URL(this.config.onebot.wsUrl);
    if (this.config.onebot.accessToken) u.searchParams.set('access_token', this.config.onebot.accessToken);
    const ws = new WebSocket(u);
    this.ws = ws;
    const deadline = setTimeout(() => { if (ws.readyState !== WebSocket.OPEN) ws.close(); }, 15000);
    ws.addEventListener('open', () => {
      clearTimeout(deadline); this.connected = true; this.reconnects = 0;
      this.log('info', 'OneBot WebSocket 已连接');
      this.call('get_login_info').then(data => { this.selfId = String(data.user_id); }).catch(() => this.log('warn', 'OneBot 登录信息探测失败'));
    });
    ws.addEventListener('message', async event => {
      try {
        const raw = typeof event.data === 'string' ? event.data : await event.data.text();
        if (Buffer.byteLength(raw) > 262144) return;
        const packet = JSON.parse(raw);
        if (packet.echo && this.pending.has(packet.echo)) {
          const p = this.pending.get(packet.echo); this.pending.delete(packet.echo); clearTimeout(p.timer);
          if (packet.status === 'ok' && packet.retcode === 0) p.resolve(packet.data);
          else p.reject(new ServiceError('onebot_action_failed'));
        } else if (packet.post_type) this.receive(packet);
      } catch { this.log('warn', '忽略无效的 OneBot 数据包'); }
    });
    ws.addEventListener('error', () => { this.log('warn', 'OneBot 连接失败，请检查端口与 Access Token'); });
    ws.addEventListener('close', () => {
      clearTimeout(deadline); this.connected = false;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new ServiceError('onebot_disconnected')); }
      this.pending.clear();
      if (!this.stopped) {
        const delay = Math.min(30000, 1000 * 2 ** Math.min(this.reconnects++, 5));
        this.reconnectTimer = setTimeout(() => this.connect(), delay);
      }
    });
  }
  receive(packet) {
    this.lastEventAt = new Date().toISOString();
    if (packet.self_id) this.selfId = String(packet.self_id);
    this.onEvent(packet);
  }
  async call(action, params = {}) {
    if (this.stopped) throw new ServiceError('onebot_stopped');
    if (this.config.onebot.mode === 'http') {
      const headers = this.config.onebot.accessToken ? { Authorization: 'Bearer ' + this.config.onebot.accessToken } : {};
      try {
        const result = await requestJson(this.config.onebot.httpUrl.replace(/\/+$/, '') + '/' + action, { body: params, headers });
        if (result.status !== 'ok' || result.retcode !== 0) throw new ServiceError('onebot_action_failed');
        return result.data;
      } catch (error) {
        if (error.code?.startsWith('onebot_')) throw error;
        throw new ServiceError('onebot_http_error', error.status || 0);
      }
    }
    if (!this.connected || this.ws.readyState !== WebSocket.OPEN) throw new ServiceError('onebot_disconnected');
    const echo = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(echo); reject(new ServiceError('onebot_timeout')); }, 15000);
      this.pending.set(echo, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ action, params, echo })); }
      catch { clearTimeout(timer); this.pending.delete(echo); reject(new ServiceError('onebot_disconnected')); }
    });
  }
  async send(event, text) {
    if (this.activeSends.size >= 20) throw new ServiceError('onebot_busy');
    const operation = this.sendChunks(event, text);
    this.activeSends.add(operation);
    try { return await operation; } finally { this.activeSends.delete(operation); }
  }
  async sendChunks(event, text) {
    const chars = Array.from(text);
    const limit = this.config.chat.maxReplyChars;
    const truncated = chars.length > limit;
    const bounded = chars.slice(0, limit);
    if (truncated) bounded.push(...'\n[回复过长，已截断]');
    for (let offset = 0; offset < bounded.length; offset += this.config.chat.chunkChars) {
      if (offset) await pause(this.config.chat.sendDelayMs);
      const message = [{ type: 'text', data: { text: bounded.slice(offset, offset + this.config.chat.chunkChars).join('') } }];
      const group = event.message_type === 'group';
      if (group && offset === 0) message.unshift({ type: 'at', data: { qq: String(event.user_id) } }, { type: 'text', data: { text: ' ' } });
      // Structured text prevents model output such as [CQ:at,qq=all] becoming an action.
      await this.call(group ? 'send_group_msg' : 'send_private_msg', {
        [group ? 'group_id' : 'user_id']: Number(group ? event.group_id : event.user_id), message
      });
    }
  }
  stop() {
    this.stopped = true; this.connected = false; clearTimeout(this.reconnectTimer);
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new ServiceError('onebot_stopped')); }
    this.pending.clear();
    try { this.ws?.close(); } catch { /* already closed */ }
  }
}
