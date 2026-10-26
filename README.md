# GPT QQ Bot

一个可本机运行的 QQ 文字聊天机器人。支持使用 ChatGPT 订阅登录，或使用独立计费的 OpenAI API Key。结构参考 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge) 的「QQ → 桥接程序 → 模型 → QQ」思路，本项目独立实现，不需要 DeepSeek Harness，也不包含 QQ 客户端或 QQ 登录协议组件。

支持私聊、群聊 @ 回复或前缀触发、人格提示词、聊天记忆、访问白名单、WebSocket 自动重连、HTTP 上报签名校验和本机图形控制台。使用 Node.js 内置功能，无需 npm install。

## 使用 ChatGPT 订阅（Plus / Pro）

v1.1.0 提供官方 **Sign in with ChatGPT** 登录入口。符合条件的账号可授权本地程序使用订阅中的 Codex / Work 额度，不需要 API Key。该额度与其他应用共用，并非无限使用；实际权限以登录授权和账号模型列表为准。[官方说明](https://learn.chatgpt.com/docs/sign-in-with-chatgpt)

1. 启动程序，打开本机控制台，在「模型使用方式」中选择「使用 ChatGPT 订阅」。
2. 点击 **Continue with ChatGPT**，在 OpenAI 页面登录并授权使用订阅额度。
3. 返回控制台，刷新可用模型并选择模型。
4. 保存配置后重启程序。后台启动模式下可直接点击「重启生效」。

首次成功授权会显示订阅用量提示；「管理用量」可打开 [ChatGPT 用量设置](https://chatgpt.com/settings/usage)。支持重新登录、保存多个连接、切换连接与退出登录。切换账号、重新登录成功或退出时清空聊天上下文，并丢弃旧账号处理中及排队的回复。

OAuth 凭据单独存放在 `state/chatgpt/`；Windows 下限制该目录的 ACL，Unix 下使用仅所有者可读写的权限。控制台不会返回这些令牌。程序不会读取 Codex 的登录凭据，也不会在订阅额度不足时自动切换到 API Key。

订阅模式按官方要求采用 `store:false`、`stream:true`，仅在收到完整结束事件后回复 QQ。该模式不发送 `max_output_tokens`，因此页面的输出 token 上限只对 API Key 模式生效；本机回复字符上限仍然生效。[官方协议与限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)

登录需由使用者在浏览器中完成。自动测试使用本机模拟服务，不代表真实账号已经获得授权或完成实际推理。若登录域名返回 HTTP 403 或 HTML 拦截页，应先解决本机访问 OpenAI 官方授权服务的连通性，再重新登录；程序不绕过网站的安全校验。

## Windows 后台启动

可以使用 `node src/launcher.js` 启动后台实例并自动打开控制台；重复执行会打开已有实例。`node src/launcher.js --restart` 重启，`--stop` 停止。程序不会设置开机自启。

已部署版如果带有 `runtime/node.exe`，也可以双击 `launch.vbs`，或让桌面快捷方式指向它。普通源码用户可以使用后文的 `start.cmd` 前台运行。后台日志位于 `state/service.log`；其中包含本机控制台令牌，请勿分享。重启会清空聊天记忆。

## 三步开始

### 1. 准备 QQ 端

需要一个你已登录、可正常工作的 **OneBot v11 服务**，例如能够提供该协议的 QQ 网关。QQ 网关的安装、登录和账号验证由你完成，本项目只连接它的接口。这里的 OneBot 账号应是用于当机器人的账号；「主人 QQ」则是你向它发消息的账号。

推荐启用网关的 **正向 WebSocket 服务**，例：

| QQ 网关中的项目 | 示例值 |
| --- | --- |
| OneBot 版本 | v11 |
| 服务类型 | 正向 WebSocket / WebSocket Server |
| 监听地址 | `127.0.0.1` |
| 端口 | `3001` |
| Access Token | 自行设置的一串随机字符 |
| 上报消息格式 | 数组格式（字符串 CQ 码格式也支持） |

机器人将主动连接 `ws://127.0.0.1:3001`。**不要把 QQ 网关配置成反向 WebSocket 客户端**，本程序没有反向 WS 服务端。不同网关的设置名称可能不同，以它实际提供的 OneBot v11 接口为准。

### 2. 启动并配置 GPT

Windows 下双击 **start.cmd**。当前电脑可以使用 Codex 附带的 Node.js；换电脑需安装 Node.js 22.13 或更新版本。macOS/Linux 也可在项目目录执行：

```sh
node src/main.js
```

第一次启动会自动生成 `config.json` 和 `state/admin-token`，然后显示控制台链接。复制启动窗口内完整的 `http://127.0.0.1:3100/#…` 链接到浏览器，按页面填写：

- **模型使用方式**：可选 ChatGPT 订阅或 API Key。订阅模式按前文登录，不需要填写 Key。
- **OpenAI API Key**：仅在 API Key 模式下需要。请在本机页面输入，不要发进 QQ 或提交到代码仓库。
- **模型名**：订阅模式从登录账号返回的模型列表中选择；API Key 示例默认 `gpt-4.1-mini`。程序不假定所有账号都具有相同模型权限。
- **API 地址**：官方默认 `https://api.openai.com/v1`。第三方兼容网关必须支持 `/responses`；只有 `/chat/completions` 的网关暂不支持。
- **OneBot 地址与 Access Token**：与 QQ 网关配置一致。
- **主人 QQ**：你自己的 QQ 号，用来私聊机器人。
- **私聊白名单、群白名单**：按需添加。空白名单表示不开放；主人 QQ 仍可私聊。

点「保存配置」，关闭启动窗口并重新运行 `start.cmd`。保存操作不热更新；页面中的连接测试始终使用正在运行的配置。重启后点「检查 QQ 连接」及「测试 GPT」分别确认两边连接。GPT 测试会进行一次真实 API 请求并消耗少量额度。

也可以复制 `.env.example` 为 `.env`，填写：

```dotenv
OPENAI_API_KEY=你的密钥
```

API Key 模式下，环境变量中的 Key 优先于 `config.json`，页面会显示其来源；订阅模式不使用它。页面输入的密钥保存在本机 `config.json` 中；控制台读取接口不返回这些密钥。删除已保存的密钥需要关闭程序后手动编辑配置文件；页面的空密钥输入框表示保留原值。

### 3. 从 QQ 发消息

用主人账号私聊机器人：「你好，介绍一下自己」。群聊需先把群号填入白名单，默认使用：

```text
@机器人 你好
@机器人 /help
@机器人 /reset
```

如果选择「仅指定前缀」，默认用 `/ask 你好` 或 `/ask /reset`。前缀后需有空格或换行。选择「白名单群的全部文字消息」后无需触发条件，会增加回复数量和 API 调用量。

| 命令 | 效果 |
| --- | --- |
| `/help` | 显示帮助，不调用模型 |
| `/ping` | 检查机器人在线情况，不调用模型；不能证明 API 可用 |
| `/reset` | 清空自己在当前私聊/群聊中的记忆，不调用模型 |

## HTTP 事件上报接法（可选）

当网关不使用正向 WS 时，启用它的 **HTTP API 服务** 和 **HTTP POST 事件上报**：

| 设置位置 | 字段 | 示例 |
| --- | --- | --- |
| QQ 网关 | HTTP API 服务 | `http://127.0.0.1:3000` |
| QQ 网关 | HTTP 上报地址 | `http://127.0.0.1:3100/onebot/events` |
| QQ 网关 | HTTP 上报签名 secret | 自行生成至少 16 位的随机字符串 |
| 本程序 | 接入方式 | HTTP API + HTTP 事件上报 |
| 本程序 | HTTP API 地址 | `http://127.0.0.1:3000` |
| 本程序 | HTTP 上报签名 Secret | 与网关 secret 相同 |
| 两边 | HTTP API Access Token | 保持一致 |

程序验证规范中的 `X-Signature: sha1=…`，立即返回 204，再在后台调用 GPT 和 QQ 发送 API，避免模型等待导致网关重复上报。**Access Token 和事件签名 secret 是两个不同用途的值**；不带 HMAC 签名的上报会被拒绝。此版本面向 QQ 网关与机器人在同一台电脑的部署，控制台和事件接收服务只监听本机。

## 会话与运行行为

- 每个私聊独立；群聊中按「机器人账号 + 群 + 用户」隔离记忆，群成员不能用 `/reset` 清除别人的记忆。
- 记忆只在内存，重启清空；默认保留最近 12 轮，超过 2 小时闲置后在处理下条事件时清理。有会话数和总字符上限。
- 同一会话排队处理，避免回复顺序混乱。默认最多 3 个会话同时处理，最多 60 个待处理/处理中消息，每个会话最多 4 个；超出上限或冷却间隔的消息静默忽略。
- 默认每会话冷却 1500 毫秒。不完整或超长输入不调用模型；默认单条输入上限 6000 字符，回复正文上限 8000 字符，每 1500 字符分段发送。
- WebSocket 断线后按退避重连，最长间隔 30 秒；重连后不自动重新发送旧请求。
- 事件在内存去重 10 分钟；重启清空去重表。模型请求和 QQ 发送不自动重试，避免不确定结果造成重复扣费或重复发言；失败的消息可由用户稍后重新提问。
- 只接收文字，忽略图片、文件、语音等消息段；混合消息只处理其中的文字。没有主动插话、联网搜索、工具执行、群管理或主动私信功能。
- 发回 QQ 的模型正文使用结构化纯文本消息段；模型输出的 CQ 码不会作为 QQ 操作执行。
- 被允许且满足触发条件的文字和对应会话上下文会发给配置的模型 API；不采集未触发的群消息用于模型上下文。请求设置 `store:false`，但这不等同于模型提供方无任何日志或留存。
- 控制台统计从程序启动开始累计，重启清零。tokens 来自模型返回值，不估算人民币费用；聊天调用即使发送到 QQ 失败，也可能已消耗订阅额度或产生 API 费用。控制台的模型连接测试独立返回 usage，不计入聊天统计。
- 日志只保留状态和错误类型，不保存正文。控制台令牌见启动窗口或 `state/admin-token`；如需更换，停止程序后删除该文件，再重启生成。

QQ 接入依赖你使用的网关及其账号状态；请留意网关自身说明和平台规则。

## 诊断与自测

```sh
node src/main.js --check
node --test
```

`--check` 检查本机运行环境和配置，不测试网络或密钥有效性。`node --test` 使用本机模拟 OpenAI、OneBot HTTP 与 WebSocket 服务，**不连接真实 QQ、不调用收费模型**。Windows 也可以双击 `test.cmd`。

| 现象 | 排查方向 |
| --- | --- |
| 私聊不回复 | 检查主人 QQ/私聊白名单、修改后是否重启、是否用了机器人账号给自己发消息 |
| 群里不回复 | 检查群白名单、真实 @ 目标、触发方式和消息是否只有图片 |
| WS 一直未连接 | 确认网关已登录、启用的是正向 WS、端口与 Token 正确 |
| HTTP 401 | 上报时检查 HMAC secret；模型请求时检查 API Key 与模型权限 |
| HTTP 404 | 检查 API 地址不要重复 `/v1` 或带 `/responses`，模型名需有权限 |
| HTTP 429 | 检查模型额度、账单或请求限额 |
| HTTP 上报无事件 | 检查网关的上报开关、路径和签名配置；「检查 QQ 连接」仅验证 API，不证明上报正常 |
| 模型无正文或到达输出上限 | 增大 `openai.maxOutputTokens`，尤其是需要思考 token 的模型 |
| 端口 3100 被占用 | 关闭另一个实例，或手动改 `config.json` 的 `port`，同时更新 HTTP 上报地址 |
| 网络连接失败/超时 | 检查本机能否访问 API；程序使用当前 Node.js 的网络配置，不自动配置代理 |

## 文件结构

```text
start.cmd              Windows 启动入口
test.cmd               Windows 自测入口
config.example.json    默认配置与高级参数
.env.example           环境变量示例
src/config.js          配置加载、验证、密钥遮蔽
src/provider.js        OpenAI Responses API
src/plan-auth.js       官方 ChatGPT 订阅登录、身份验证与令牌续期
src/onebot.js          OneBot WS/HTTP 客户端
src/bot.js             路由、会话、排队、去重
src/server.js          本机控制台与签名事件接收
src/main.js            程序入口
public/index.html      中文控制台
test/bot.test.js       离线自动测试
test/plan-auth.test.js  订阅登录及流式推理模拟测试
test/launcher.test.js   后台启动生命周期测试
```

## 协议与参考

- 设计思路参考：[Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)。本实现不依赖其 DSH 协议或 SnowLuma SDK。
- [OpenAI 文本生成](https://developers.openai.com/api/docs/guides/text)、[Responses API 迁移说明](https://developers.openai.com/api/docs/guides/migrate-to-responses)、[GPT-4.1 mini 模型说明](https://developers.openai.com/api/docs/models/gpt-4.1-mini)。模型的账号可用性以你账户实际返回为准。
- [ChatGPT 本地应用登录](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)、[账号与续期](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)、[订阅模式推理](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)。
- [OneBot v11 正向 WebSocket](https://github.com/botuniverse/onebot-11/blob/master/communication/ws.md)、[HTTP POST 与 HMAC 签名](https://github.com/botuniverse/onebot-11/blob/master/communication/http-post.md)、[鉴权](https://github.com/botuniverse/onebot-11/blob/master/communication/authorization.md)。

MIT License，见 LICENSE。
