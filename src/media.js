import { ServiceError } from './provider.js';

const decode = s => s.replaceAll('&#91;', '[').replaceAll('&#93;', ']').replaceAll('&#44;', ',').replaceAll('&amp;', '&');
export function mediaSegments(message) {
  const segments = Array.isArray(message) ? message : [];
  if (typeof message === 'string') {
    for (const match of message.matchAll(/\[CQ:([^,\]]+)((?:,[^\]]*)?)\]/g)) {
      const data = Object.fromEntries(match[2].split(',').filter(Boolean).map(field => { const i = field.indexOf('='); return [field.slice(0, i), decode(field.slice(i + 1))]; }));
      segments.push({ type: match[1], data });
    }
  }
  const images = [], faces = [];
  for (const segment of segments) {
    if (!segment || typeof segment !== 'object') continue;
    const type = segment.type, data = segment.data && typeof segment.data === 'object' ? segment.data : {};
    if (type === 'image' || type === 'mface') images.push({ file: String(data.file ?? data.file_id ?? ''), url: String(data.url ?? ''), emojiId: String(data.emoji_id ?? data.emojiId ?? ''), sticker: type === 'mface' });
    if (type === 'face') faces.push('[QQ表情：' + String(data.summary || data.name || '编号' + (data.id ?? '?')).slice(0, 80) + ']');
  }
  return { images, faces };
}
export function safeImageUrl(raw) {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    const allowed = host === 'qpic.cn' || host.endsWith('.qpic.cn') || ['multimedia.nt.qq.com', 'gxh.vip.qq.com', 'q.qlogo.cn', 'p.qlogo.cn'].includes(host);
    if (!allowed || !['https:', 'http:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) return null;
    return url.href;
  } catch { return null; }
}
export const safeImageRef = value => typeof value === 'string' && value.length <= 512 && !value.includes('..') && /^[\w.+=@-]+$/.test(value);
function gifFirstFrame(bytes) {
  if (bytes.length < 14) throw new ServiceError('image_invalid');
  let offset = 13 + ((bytes[10] & 128) ? 3 * (2 ** ((bytes[10] & 7) + 1)) : 0);
  const output = [bytes.subarray(0, offset)]; let control = null;
  const blocks = start => { let i = start; while (i < bytes.length) { const size = bytes[i++]; if (!size) return i; i += size; } throw new ServiceError('image_invalid'); };
  while (offset < bytes.length) {
    const start = offset;
    if (bytes[offset] === 0x21) {
      offset = blocks(offset + 2);
      if (bytes[start + 1] === 0xf9) control = bytes.subarray(start, offset);
    } else if (bytes[offset] === 0x2c) {
      if (offset + 10 >= bytes.length) throw new ServiceError('image_invalid');
      const packed = bytes[offset + 9]; offset += 10;
      if (packed & 128) offset += 3 * (2 ** ((packed & 7) + 1));
      offset = blocks(offset + 1);
      if (control) output.push(control);
      output.push(bytes.subarray(start, offset), Buffer.from([0x3b])); return Buffer.concat(output);
    } else throw new ServiceError('image_invalid');
  }
  throw new ServiceError('image_invalid');
}
function webpFirstFrame(bytes) {
  for (let i = 12; i + 8 <= bytes.length;) {
    const type = bytes.toString('ascii', i, i + 4), size = bytes.readUInt32LE(i + 4), end = i + 8 + size;
    if (end > bytes.length) throw new ServiceError('image_invalid');
    if (type === 'ANMF') {
      if (size < 24) throw new ServiceError('image_invalid');
      const frame = bytes.subarray(i + 24, end), extended = Buffer.alloc(18);
      extended.write('VP8X'); extended.writeUInt32LE(10, 4);
      const frameType = frame.toString('ascii', 0, 4);
      extended[8] = frameType === 'ALPH' || (frameType === 'VP8L' && frame.length > 12 && (frame[12] & 16)) ? 16 : 0;
      bytes.copy(extended, 12, i + 14, i + 20);
      const payload = Buffer.concat([Buffer.from('WEBP'), extended, frame]);
      const header = Buffer.alloc(8); header.write('RIFF'); header.writeUInt32LE(payload.length, 4);
      return Buffer.concat([header, payload]);
    }
    i = end + (size % 2);
  }
  return bytes;
}
export function normalizeImage(raw, maxBytes = 5 * 1024 * 1024) {
  let bytes = Buffer.from(raw), mime;
  if (!bytes.length || bytes.length > maxBytes) throw new ServiceError('image_too_large');
  let width = 0, height = 0;
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    if (bytes.length < 24) throw new ServiceError('image_invalid');
    mime = 'image/png'; width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
    const parts = [bytes.subarray(0, 8)];
    for (let i = 8; i + 12 <= bytes.length;) {
      const size = bytes.readUInt32BE(i), end = i + size + 12, type = bytes.toString('ascii', i + 4, i + 8);
      if (end > bytes.length) throw new ServiceError('image_invalid');
      if (!['acTL', 'fcTL', 'fdAT'].includes(type)) parts.push(bytes.subarray(i, end));
      i = end;
    }
    bytes = Buffer.concat(parts);
  } else if (/^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) {
    mime = 'image/gif'; width = bytes.readUInt16LE(6); height = bytes.readUInt16LE(8); bytes = gifFirstFrame(bytes);
  } else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    mime = 'image/jpeg';
    for (let i = 2; i + 8 < bytes.length;) {
      if (bytes[i++] !== 255) break;
      const marker = bytes[i++]; if (marker === 0xda || marker === 0xd9) break;
      const size = bytes.readUInt16BE(i); if (size < 2) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) { height = bytes.readUInt16BE(i + 3); width = bytes.readUInt16BE(i + 5); break; }
      i += size;
    }
  } else if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    mime = 'image/webp'; bytes = webpFirstFrame(bytes);
    if (bytes.toString('ascii', 12, 16) === 'VP8X' && bytes.length >= 30) { width = 1 + bytes.readUIntLE(24, 3); height = 1 + bytes.readUIntLE(27, 3); }
    else if (bytes.toString('ascii', 12, 16) === 'VP8L' && bytes.length >= 25) { const packed = bytes.readUInt32LE(21); width = 1 + (packed & 16383); height = 1 + ((packed >>> 14) & 16383); }
    else if (bytes.toString('ascii', 12, 16) === 'VP8 ' && bytes.length >= 30) { width = bytes.readUInt16LE(26) & 16383; height = bytes.readUInt16LE(28) & 16383; }
  } else throw new ServiceError('image_invalid');
  if (width * height > 25_000_000) throw new ServiceError('image_too_large');
  return { type: 'input_image', image_url: 'data:' + mime + ';base64,' + bytes.toString('base64'), detail: 'auto' };
}
export class MediaResolver {
  constructor(config, call, { fetchImpl = fetch } = {}) { this.config = config; this.call = call; this.fetch = fetchImpl; }
  async download(raw) {
    let url = safeImageUrl(raw);
    for (let attempt = 0; url && attempt < 4; attempt++) {
      const response = await this.fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const next = response.headers.get('location'); await response.body?.cancel();
        url = next ? safeImageUrl(new URL(next, url).href) : null; continue;
      }
      const limit = this.config.vision.maxImageBytes;
      if (!response.ok || Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new ServiceError('image_download_failed'); }
      const reader = response.body.getReader(), chunks = []; let length = 0;
      try {
        while (true) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > limit) throw new ServiceError('image_too_large'); chunks.push(value); }
      } finally { await reader.cancel().catch(() => {}); }
      return normalizeImage(Buffer.concat(chunks), limit);
    }
    throw new ServiceError('image_download_failed');
  }
  async one(media) {
    let info = null;
    if (safeImageRef(media.file) && !media.sticker && !media.emojiId) {
      try { info = await this.call('get_image', { file: media.file }); } catch {}
    }
    if (info) {
      const base64 = typeof info.base64 === 'string' ? info.base64 : typeof info.file === 'string' && info.file.startsWith('base64://') ? info.file.slice(9) : null;
      if (base64 && base64.length <= Math.ceil(this.config.vision.maxImageBytes / 3) * 4) return normalizeImage(Buffer.from(base64, 'base64'), this.config.vision.maxImageBytes);
    }
    const urls = [info?.url, info?.file, media.url];
    if (/^[a-f0-9]{16,64}$/i.test(media.emojiId)) urls.push(`https://gxh.vip.qq.com/club/item/parcel/item/${media.emojiId.slice(0, 2)}/${media.emojiId}/raw300.gif`);
    for (const url of [...new Set(urls.filter(x => safeImageUrl(x)))]) { try { return await this.download(url); } catch {} }
    throw new ServiceError('image_download_failed');
  }
  async resolve(images) {
    const parts = []; let failed = 0;
    for (const image of images.slice(0, this.config.vision.maxImages)) { try { parts.push(await this.one(image)); } catch { failed++; } }
    return { parts, failed, skipped: Math.max(0, images.length - this.config.vision.maxImages) };
  }
}
export const textSize = content => typeof content === 'string' ? content.length : (content ?? []).reduce((n, part) => n + (part.type === 'input_text' ? part.text.length : 100), 0);
export const imageBytes = messages => messages.reduce((n, message) => n + (Array.isArray(message.content) ? message.content.reduce((sum, part) => sum + (part.type === 'input_image' ? Math.ceil(part.image_url.length * 0.75) : 0), 0) : 0), 0);
export function stripImages(message) {
  if (!Array.isArray(message.content)) return message;
  return { ...message, content: message.content.map(part => part.type === 'input_image' ? { type: 'input_text', text: '[较早的图片已从视觉记忆中移除，请勿猜测其中未确认的细节]' } : part) };
}
