import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import net from 'node:net';
import { ROOT, loadConfig, adminToken, atomicWrite } from './config.js';

const state = resolve(ROOT, 'state');
mkdirSync(state, { recursive: true });
const recordPath = resolve(state, 'process.json');
const lockPath = resolve(state, 'launcher.lock');
const wait = ms => new Promise(r => setTimeout(r, ms));
const readRecord = () => { try { return JSON.parse(readFileSync(recordPath, 'utf8')); } catch { return null; } };
const alive = pid => { try { if (!Number.isInteger(pid) || pid < 1) return false; process.kill(pid, 0); return true; } catch { return false; } };
async function probe(port, token) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { 'X-Admin-Token': token }, signal: AbortSignal.timeout(800) });
    if (!response.ok) return null;
    const value = await response.json();
    return value.application === 'gpt-qq-bot' && Number.isInteger(value.processId) ? value : null;
  } catch { return null; }
}
async function portBusy(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(800);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => { socket.destroy(); resolve(true); });
  });
}
function browser(port, token) {
  const url = `http://127.0.0.1:${port}/#${token}`;
  const command = process.platform === 'win32' ? 'rundll32.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {}); child.unref();
}
async function lock() {
  for (let i = 0; i < 60; i++) {
    try { const fd = openSync(lockPath, 'wx'); writeFileSync(fd, JSON.stringify({ pid: process.pid })); closeSync(fd); return; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let holder; try { holder = JSON.parse(readFileSync(lockPath, 'utf8')); } catch { holder = null; }
      if (holder && !alive(holder.pid)) { try { unlinkSync(lockPath); } catch {} continue; }
      await wait(100);
    }
  }
  throw new Error('Another launch is still in progress. Try again shortly.');
}
async function stopManaged(record, running, token) {
  if (!running) {
    if (record && alive(record.pid)) throw new Error('A recorded process is still starting or cannot be verified. No process was stopped.');
    return;
  }
  if (!record || record.pid !== running.processId) throw new Error('This server was started manually. Stop it in its original window first.');
  const response = await fetch(`http://127.0.0.1:${record.port}/api/stop`, { method: 'POST', headers: { 'X-Admin-Token': token, 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw new Error('The running server refused to stop.');
  for (let i = 0; i < 100; i++) { if (!alive(record.pid)) return; await wait(100); }
  throw new Error('The running server did not finish stopping.');
}
async function launch() {
  const args = new Set(process.argv.slice(2));
  const config = loadConfig();
  const token = adminToken();
  if (args.has('--status')) {
    const record = readRecord(), port = record?.port || config.port;
    const running = await probe(port, token);
    console.log(JSON.stringify({ running: Boolean(running), port, processId: running?.processId ?? null, managed: Boolean(running?.managed) }));
    return;
  }
  await lock();
  try {
    const record = readRecord();
    const oldPort = record?.port || config.port;
    let running = await probe(oldPort, token);
    if (args.has('--stop') || args.has('--restart')) {
      await stopManaged(record, running, token); running = null;
      if (existsSync(recordPath)) unlinkSync(recordPath);
      if (args.has('--stop')) { console.log('GPT QQ Bot stopped.'); return; }
    }
    if (running) {
      if (!args.has('--no-browser')) browser(oldPort, token);
      console.log('GPT QQ Bot is already running.'); return;
    }
    if (await portBusy(config.port)) throw new Error('Port ' + config.port + ' is already in use. Change the bot port or close the other service.');
    const executable = process.platform === 'win32' && existsSync(resolve(ROOT, 'runtime/node.exe')) ? resolve(ROOT, 'runtime/node.exe') : process.execPath;
    const fd = openSync(resolve(state, 'service.log'), 'a');
    let child;
    try {
      child = spawn(executable, [resolve(ROOT, 'src/main.js')], { cwd: ROOT, detached: true, windowsHide: true, stdio: ['ignore', fd, fd], env: { ...process.env, GPT_QQ_MANAGED: '1' } });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    } finally { closeSync(fd); }
    child.unref();
    atomicWrite(recordPath, JSON.stringify({ pid: child.pid, port: config.port, startedAt: new Date().toISOString() }, null, 2));
    for (let i = 0; i < 100; i++) {
      const status = await probe(config.port, token);
      if (status?.processId === child.pid) {
        if (!args.has('--no-browser')) browser(config.port, token);
        console.log('GPT QQ Bot started on http://127.0.0.1:' + config.port); return;
      }
      if (!alive(child.pid)) break;
      await wait(100);
    }
    throw new Error('Startup did not complete. See state/service.log in the installation directory.');
  } finally {
    try { const holder = JSON.parse(readFileSync(lockPath, 'utf8')); if (holder.pid === process.pid) unlinkSync(lockPath); } catch {}
  }
}
try { await launch(); }
catch (error) {
  const message = error instanceof Error ? error.message : 'Unknown launcher error';
  writeFileSync(resolve(state, 'launcher-error.log'), new Date().toISOString() + '\n' + message + '\n');
  console.error(message); process.exitCode = 1;
}
