import { existsSync, openSync, closeSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { ROOT, loadConfig, apiKey, adminToken } from './config.js';
import { Bot } from './bot.js';
import { OneBot } from './onebot.js';
import { createServer } from './server.js';
import { getPlanAuth } from './plan-auth.js';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) { console.error('请安装 Node.js 22.13 或更新版本。'); process.exit(1); }
if (existsSync(resolve(ROOT, '.env'))) process.loadEnvFile(resolve(ROOT, '.env'));
let config;
try { config = loadConfig(); } catch (e) { console.error('无法加载配置：' + e.message); process.exit(1); }
if (process.argv.includes('--check')) {
  console.log('Node.js：' + process.version + '\n配置格式：有效\nGPT 模型：' + config.openai.model + '\nAPI Key：' + (apiKey(config) ? '已设置' : '尚未设置') + '\nOneBot 模式：' + config.onebot.mode + '\n私聊白名单：' + config.access.privateUsers.length + '\n群白名单：' + config.access.groups.length);
  process.exit(0);
}
const logs = [];
const log = (level, message) => {
  const entry = { time: new Date().toISOString(), level, message };
  logs.push(entry); if (logs.length > 100) logs.shift();
  console.log(`[${entry.time}] ${level.toUpperCase()} ${message}`);
};
const token = adminToken();
const planAuth = getPlanAuth();
let bot;
const onebot = new OneBot(config, event => { void bot.accept(event); }, log);
bot = new Bot(config, { send: (event, text) => onebot.send(event, text), log });
const managed = process.env.GPT_QQ_MANAGED === '1';
const restart = managed ? () => {
  const fd = openSync(resolve(ROOT, 'state/launcher.log'), 'a');
  try {
    const child = spawn(process.execPath, [resolve(ROOT, 'src/launcher.js'), '--restart', '--no-browser'], { cwd: ROOT, detached: true, windowsHide: true, stdio: ['ignore', fd, fd] });
    child.on('error', () => log('error', '无法启动重启程序，请使用本地重启入口')); child.unref();
  } finally { closeSync(fd); }
} : null;
const server = createServer({ config, token, bot, onebot, logs, onRestart: restart, onStop: stop, planAuth });
server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `端口 ${config.port} 已被占用，请关闭另一个实例或修改 config.json 的 port。` : '控制台无法启动：' + error.code); process.exit(1); });
server.listen(config.port, '127.0.0.1', () => {
  console.log('\nGPT QQ Bot 1.2.0\n控制台：http://127.0.0.1:' + config.port + '/#' + token + '\n控制台令牌：' + token + '\n关闭程序：Ctrl+C\n');
  if (config.openai.authMode === 'chatgpt' && !planAuth.status().planEnabled) log('warn', '请在本机控制台点击 Continue with ChatGPT，登录并授权使用订阅额度');
  else if (config.openai.authMode !== 'chatgpt' && !apiKey(config)) log('warn', '请先在本机控制台填写 API Key、主人 QQ 和白名单，保存后重启');
  onebot.start();
});
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true; bot.stop(); onebot.stop(); server.close();
  const timer = setTimeout(() => process.exit(0), 2000); timer.unref();
}
process.on('SIGINT', stop); process.on('SIGTERM', stop);
