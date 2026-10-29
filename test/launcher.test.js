import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import http from 'node:http';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { ROOT, defaults } from '../src/config.js';

const execute = promisify(execFile);
test('launcher applies .env proxy settings before the background Node process starts', { timeout: 25000, skip: !process.allowedNodeEnvironmentFlags.has('--use-env-proxy') }, async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'gpt qq proxy-'));
  const proxy = http.createServer((req, res) => {
    if (req.url !== 'http://gpt-qq-proxy-test.invalid/') { res.writeHead(502); res.end(); return; }
    res.end('local-proxy-ok');
  });
  proxy.on('connect', (req, socket, head) => {
    if (req.url !== 'gpt-qq-proxy-test.invalid:80') { socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); return; }
    socket.on('error', () => {});
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    let input = head.toString();
    socket.on('data', part => {
      input += part.toString();
      if (input.includes('\r\n\r\n')) socket.end('HTTP/1.1 200 OK\r\nContent-Length: 14\r\nConnection: close\r\n\r\nlocal-proxy-ok');
    });
  });
  await new Promise(r => proxy.listen(0, '127.0.0.1', r));
  const free = net.createServer(); await new Promise(r => free.listen(0, '127.0.0.1', r)); const port = free.address().port; await new Promise(r => free.close(r));
  for (const entry of ['src', 'public', 'package.json', 'config.example.json']) cpSync(resolve(ROOT, entry), resolve(dir, entry), { recursive: true });
  const config = defaults(); config.port = port;
  writeFileSync(resolve(dir, 'config.json'), JSON.stringify(config));
  writeFileSync(resolve(dir, '.env'), `NODE_USE_ENV_PROXY=1\nHTTP_PROXY=http://127.0.0.1:${proxy.address().port}\nNO_PROXY=localhost,127.0.0.1,::1\n`);
  writeFileSync(resolve(dir, 'src/main.js'), `
    import http from 'node:http';
    import { loadConfig, adminToken } from './config.js';
    const config = loadConfig(), token = adminToken();
    const response = await fetch('http://gpt-qq-proxy-test.invalid/', { signal: AbortSignal.timeout(5000) });
    const proxyResult = await response.text();
    const server = http.createServer((req, res) => {
      if (req.headers['x-admin-token'] !== token) { res.writeHead(401); res.end(); return; }
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/stop' && req.method === 'POST') { res.end('{}'); setTimeout(() => process.exit(0), 100); return; }
      res.end(JSON.stringify({ application: 'gpt-qq-bot', processId: process.pid, managed: true, proxyResult }));
    });
    server.listen(config.port, '127.0.0.1');
  `);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(https?_proxy|all_proxy|no_proxy|node_use_env_proxy)$/i.test(key)) delete env[key];
  const launch = (...args) => execute(process.execPath, [resolve(dir, 'src/launcher.js'), ...args], { cwd: dir, env, timeout: 18000, windowsHide: true });
  try {
    await launch('--no-browser');
    const token = readFileSync(resolve(dir, 'state/admin-token'), 'utf8').trim();
    const response = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { 'X-Admin-Token': token }, signal: AbortSignal.timeout(2000) });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).proxyResult, 'local-proxy-ok');
  } finally {
    try { await launch('--stop'); } catch {}
    proxy.closeAllConnections(); await new Promise(r => proxy.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('desktop launcher starts one background process, reopens, applies config on restart and stops', { timeout: 35000 }, async () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'gpt qq launcher-'));
  for (const entry of ['src', 'public', 'package.json', 'config.example.json']) cpSync(resolve(ROOT, entry), resolve(dir, entry), { recursive: true });
  const free = net.createServer(); await new Promise(r => free.listen(0, '127.0.0.1', r)); const port = free.address().port; await new Promise(r => free.close(r));
  const config = defaults(); config.port = port; config.onebot.mode = 'http'; config.onebot.eventSecret = 'test-secret-123456789';
  writeFileSync(resolve(dir, 'config.json'), JSON.stringify(config));
  const launch = (...args) => execute(process.execPath, [resolve(dir, 'src/launcher.js'), ...args], { cwd: dir, timeout: 18000, windowsHide: true });
  const url = `http://127.0.0.1:${port}`;
  let token;
  const status = async () => {
    const response = await fetch(url + '/api/status', { headers: { 'X-Admin-Token': token }, signal: AbortSignal.timeout(1000) });
    assert.equal(response.status, 200); return response.json();
  };
  try {
    await launch('--no-browser'); token = readFileSync(resolve(dir, 'state/admin-token'), 'utf8').trim();
    const first = await status(); assert.equal(first.managed, true); assert.equal(first.application, 'gpt-qq-bot');
    await launch('--no-browser'); assert.equal((await status()).processId, first.processId);
    const headers = { 'X-Admin-Token': token, 'Content-Type': 'application/json' };
    assert.equal((await fetch(url + '/api/restart', { method: 'POST', body: '{}' })).status, 401);
    const save = await fetch(url + '/api/config', { method: 'POST', headers, body: JSON.stringify({ openai: { model: 'configured-after-restart' } }) }); assert.equal(save.status, 200);
    assert.equal((await fetch(url + '/api/restart', { method: 'POST', headers, body: '{}' })).status, 200);
    let restarted;
    for (let i = 0; i < 160; i++) {
      await new Promise(r => setTimeout(r, 100));
      try { const s = await status(); if (s.processId !== first.processId) { restarted = s; break; } } catch {}
    }
    assert.ok(restarted, 'background restart did not complete'); assert.equal(restarted.model, 'configured-after-restart');
    const snapshot = JSON.parse((await launch('--status')).stdout); assert.equal(snapshot.processId, restarted.processId);
    await launch('--stop');
    await assert.rejects(fetch(url + '/api/status', { signal: AbortSignal.timeout(1000) }));
  } finally {
    try { await launch('--stop'); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});
