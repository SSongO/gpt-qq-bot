import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { ROOT, defaults } from '../src/config.js';

const execute = promisify(execFile);
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
