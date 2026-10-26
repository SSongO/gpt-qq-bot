import { apiKey } from './config.js';
import { getPlanAuth, RESOURCE } from './plan-auth.js';

export class ServiceError extends Error {
  constructor(code, status = 0) { super(code); this.code = code; this.status = status; }
}
export async function requestJson(url, { body, headers = {}, timeoutMs = 15000 } = {}) {
  let response;
  try {
    response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    if (!response.ok) { await response.body?.cancel(); throw new ServiceError('http_error', response.status); }
    // Bound remote responses so a broken gateway cannot exhaust local memory.
    const reader = response.body.getReader();
    const chunks = []; let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2_000_000) { await reader.cancel(); throw new ServiceError('response_too_large'); }
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new ServiceError('invalid_json'); }
  } catch (e) {
    if (e instanceof ServiceError) throw e;
    throw new ServiceError(['TimeoutError', 'AbortError'].includes(e.name) ? 'timeout' : 'network_error');
  }
}
export function extractText(response) {
  const parts = [];
  for (const item of response.output ?? []) {
    if (item.type !== 'message' || item.role !== 'assistant') continue;
    for (const part of item.content ?? []) {
      if (part.type === 'output_text' && typeof part.text === 'string') parts.push(part.text);
      if (part.type === 'refusal' && typeof part.refusal === 'string') parts.push(part.refusal);
    }
  }
  return parts.join('\n').trim();
}
export async function generate(config, messages, options = {}) {
  if (config.openai.authMode === 'chatgpt') return generateWithPlan(config, messages, options);
  const key = apiKey(config);
  if (!key) throw new ServiceError('missing_api_key');
  const response = await requestJson(config.openai.baseUrl.replace(/\/+$/, '') + '/responses', {
    headers: { Authorization: 'Bearer ' + key }, timeoutMs: config.openai.timeoutMs,
    body: { model: config.openai.model, instructions: config.openai.systemPrompt, input: messages, max_output_tokens: config.openai.maxOutputTokens, store: false }
  });
  if (response.error || response.status === 'failed') throw new ServiceError('model_error');
  const text = extractText(response);
  if (!text) throw new ServiceError(response.status === 'incomplete' ? 'output_limit' : 'empty_response');
  return { text, usage: response.usage ?? {}, incomplete: response.status === 'incomplete' };
}
function planFailure(code, status = 0) {
  if (code === 'subscription_sharing_usage_limit_exceeded') return new ServiceError('chatgpt_usage_limit', status);
  if (code === 'subscription_sharing_usage_unavailable') return new ServiceError('chatgpt_usage_unavailable', status);
  if (status === 401 || status === 403) return new ServiceError('chatgpt_authorization_required', status);
  if (status === 429) return new ServiceError('chatgpt_usage_limit', status);
  return new ServiceError('chatgpt_model_error', status);
}
export async function generateWithPlan(config, messages, { planAuth = getPlanAuth(), fetchImpl = fetch } = {}) {
  const token = await planAuth.accessToken();
  let reader;
  try {
    // Plan credentials go only to the official endpoint, never a configured gateway.
    const response = await fetchImpl(RESOURCE + '/responses', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(config.openai.timeoutMs),
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.openai.model, instructions: config.openai.systemPrompt, input: messages, store: false, stream: true })
    });
    if (!response.ok) {
      let code; try { code = (await response.json()).error?.code; } catch {}
      throw planFailure(code, response.status);
    }
    if (!response.headers.get('content-type')?.includes('text/event-stream')) throw new ServiceError('chatgpt_invalid_stream');
    reader = response.body.getReader();
    const decoder = new TextDecoder(); let buffer = '', currentEvent = [], text = '', total = 0, completed = null;
    function dispatch() {
      const raw = currentEvent.filter(x => x.startsWith('data:')).map(x => x.slice(5).replace(/^ /, '')).join('\n'); currentEvent = [];
      if (!raw || raw === '[DONE]') return;
      let value; try { value = JSON.parse(raw); } catch { throw new ServiceError('chatgpt_invalid_stream'); }
      if (value.type === 'response.output_text.delta' && typeof value.delta === 'string') text += value.delta;
      if (value.type === 'response.refusal.delta' && typeof value.delta === 'string') text += value.delta;
      if (value.type === 'response.failed') throw planFailure(value.response?.error?.code);
      if (value.type === 'error') throw planFailure(value.code ?? value.error?.code);
      if (value.type === 'response.incomplete') throw new ServiceError('chatgpt_incomplete');
      if (value.type === 'response.completed') {
        if (value.response?.status && value.response.status !== 'completed') throw new ServiceError('chatgpt_incomplete');
        completed = value.response ?? {};
      }
    }
    while (true) {
      const { value, done } = await reader.read();
      if (done) { buffer += decoder.decode(); break; }
      total += value.length;
      if (total > 8_000_000) throw new ServiceError('response_too_large');
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, ''); buffer = buffer.slice(index + 1);
        if (line) currentEvent.push(line); else dispatch();
        if (completed) break;
      }
      if (buffer.length > 2_000_000) throw new ServiceError('response_too_large');
      if (completed) break;
    }
    if (!completed && buffer) { currentEvent.push(buffer.replace(/\r$/, '')); dispatch(); }
    if (!completed && currentEvent.length) dispatch();
    if (!completed) throw new ServiceError('chatgpt_interrupted_stream');
    const answer = extractText(completed) || text.trim();
    if (!answer) throw new ServiceError('empty_response');
    return { text: answer, usage: completed.usage ?? {}, incomplete: false };
  } catch (e) {
    if (e.code) throw e;
    throw new ServiceError(['TimeoutError', 'AbortError'].includes(e.name) ? 'timeout' : 'chatgpt_network_error');
  } finally { try { await reader?.cancel(); } catch {} }
}
export function userError(error) {
  if (error.code === 'chatgpt_network_blocked') return '当前网络访问 OpenAI 官方授权服务被拦截（HTTP 403）。请管理员检查网络连通性后重新登录。';
  if (error.code === 'chatgpt_network_error') return '无法连接 OpenAI 授权或订阅服务，请管理员检查网络后重试。';
  if (['chatgpt_not_signed_in', 'chatgpt_login_expired', 'chatgpt_authorization_required'].includes(error.code)) return '请管理员在本机控制台使用 ChatGPT 登录并授权订阅额度。';
  if (error.code === 'chatgpt_plan_not_enabled') return '已登录 ChatGPT，但尚未授权使用订阅额度，请管理员重新授权。';
  if (error.code === 'chatgpt_usage_limit') return 'ChatGPT 订阅额度已达上限，请管理员在控制台的「管理用量」查看限额或等待恢复。';
  if (error.code === 'chatgpt_usage_unavailable') return '当前账号或工作区暂不可使用 ChatGPT 订阅额度，请管理员检查订阅与授权。';
  if (error.code === 'chatgpt_incomplete' || error.code === 'chatgpt_interrupted_stream') return '本次模型回复未完整结束，请稍后重新提问。';
  if (error.code === 'missing_api_key') return '机器人尚未配置 OpenAI API Key，请联系管理员。';
  if (error.status === 401 || error.status === 403) return '模型服务鉴权失败，请管理员检查 API Key 和模型权限。';
  if (error.status === 429) return '模型服务额度不足或请求过于频繁，请稍后再试。';
  if (error.status === 404) return '模型或接口不存在，请管理员检查模型名与 API 地址。';
  if (error.code === 'timeout') return '模型回复超时，请稍后再试。';
  if (error.code === 'output_limit') return '模型在输出限制内未能生成正文，请管理员增大输出 token 上限。';
  return '暂时无法取得模型回复，请稍后再试；管理员可在控制台查看错误类型。';
}
