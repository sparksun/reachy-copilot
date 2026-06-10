---
title: Reachy Copilot
emoji: 🤖
colorFrom: indigo
colorTo: purple
sdk: static
app_file: dist/index.html
app_build_command: npm install && npm run build
pinned: false
hf_oauth: true
short_description: Chat with Hermes AI — watch your Reachy Mini react in real time
tags:
  - reachy_mini
  - reachy_mini_js_app
---

# Reachy Copilot

基于 [Hermes Agent](https://hermes-agent.nousresearch.com/) 与 Gemini Live 的 Reachy Mini 对话式 AI 控制界面。

## 功能

| 功能 | 说明 |
|------|------|
| 💬 **Text 对话模式** | 流式接收 Hermes Agent 实时回复（SSE 串流），支持文字与语音输入 |
| 🎙️ **Realtime 语音模式** | 通过 Gemini Live API 实现双向实时语音对话（低延迟，无需按钮） |
| 🤖 **机器人动作调度** | AI 回复中嵌入动作指令，实时驱动机器人肢体（Text 模式通过 `[ACTION:xxx]` 标签，Realtime 模式通过 Function Calling） |
| 👁️ **摄像头视觉** | Realtime 模式下可语音询问"你看到什么"，AI 截取摄像头帧并描述画面 |
| 🌙 **响应式界面** | 深色优先、移动端适配 |

---

## 本地开发

### 前提依赖

- **Node.js** ≥ 18
- **Python 3** + `aiohttp` + `websockets`（信令桥依赖）

```bash
# 安装 Python 依赖（一次性）
pip install aiohttp websockets
```

### 1. 安装前端依赖

```bash
npm install
```

### 2. 配置环境变量

```bash
cp .env.local.example .env.local
```

编辑 `.env.local`，填入以下值：

| 变量 | 说明 | 必填 |
|------|------|------|
| `HF_TOKEN` | HF 个人访问令牌（[生成地址](https://huggingface.co/settings/tokens)，read 权限） | 二选一 |
| `HF_USERNAME` | 你的 HF 用户名（如 `sparkunt`） | 二选一 |
| `HF_OAUTH_CLIENT_ID` | HF OAuth 应用 Client ID（支持共享机器人，见下文） | 二选一 |
| `HERMES_URL` | Hermes Agent API 地址 | ✅ |
| `HERMES_KEY` | Hermes `API_SERVER_KEY` | ✅ |
| `CF_AI_TOKEN` | Cloudflare AI Gateway Token（Realtime 模式） | Realtime 用 |
| `CF_ACCOUNT_ID` | Cloudflare 账户 ID | Realtime 用 |
| `CF_GATEWAY_ID` | Cloudflare AI Gateway ID | Realtime 用 |
| `HERMES_GOOGLE_API_KEY` | Google AI Studio API Key | Realtime 用 |

### 3. 启动所有服务（三个终端）

本地开发需要同时运行三层服务：

**终端 1 — 前端开发服务器**

```bash
npm run dev
# → http://localhost:5173
```

**终端 2 — 本地信令桥（连接真实机器人必须）**

```bash
python3 local_signaling_bridge.py
# → 监听 http://localhost:9090
# SDK Host Shell 通过此桥与机器人 GStreamer webrtcsink 建立 WebRTC
```

> 信令桥验证：`curl -s http://localhost:9090/api/robot-status | python3 -m json.tool`  
> 正常返回 `{"robots": [...]}` 或 `{"robots": []}（机器人未上电时）`

**终端 3 — 机器人侧（可选，有实体机器人时）**

机器人端的 GStreamer webrtcsink daemon 开机自启，通常无需手动操作（监听 `ws://127.0.0.1:8443`）。

#### 架构关系

```
浏览器 (localhost:5173)
  └── SDK Host Shell ──HTTP──▶ local_signaling_bridge.py (:9090)
        └── iframe (embed.ts)       └──WS──▶ GStreamer webrtcsink (:8443)
              ├── hermes.ts                    [机器人 WebRTC 流]
              ├── gemini-live.ts
              └── actions.ts
```

---

## 两种对话模式

### Text 模式（默认）

- **输入**：文字框输入或点击 🎤 按钮语音输入（浏览器 Web Speech API）
- **AI**：Hermes Agent（SSE 串流）
- **动作触发**：AI 回复中的 `[ACTION:xxx]` 标签实时解析，驱动机器人
- **表情**：工具执行中天线交替竖起（"思考中"动画）

### Realtime 模式

点击界面右上角切换到 **Realtime 模式**，全程免手动按钮：

- **输入**：持续麦克风采集（16kHz PCM → Gemini Live）
- **AI**：Gemini Live API（`gemini-2.5-flash-native-audio-latest`，通过 Cloudflare AI Gateway 代理）
- **动作触发**：Gemini **Function Calling**（`robot_action` 工具），模型自主语义判断
- **视觉**：语音询问"你看到什么" → `capture_camera` 工具截帧 → Gemini 描述画面
- **转录**：实时显示用户说话内容和 AI 回复文字

#### Realtime 模式支持的语音指令（示例）

| 你说（中英均可）| Reachy 动作 |
|----------------|-------------|
| Reachy 摇摇头 | 头部左右摇 |
| Reachy 点个头 | 头部前倾点头 |
| 头往左歪一下 | 头部左倾 |
| 看看你周围 / 你看到什么 | 截取摄像头画面，AI 描述 |
| 旋转一圈 | 机身 360° 旋转 |

---

## 动作词汇表（Text 模式 `[ACTION:xxx]` 标签）

| 触发标签 | 机器人动作 | 典型触发场景 |
|----------|------------|-------------|
| `[ACTION:nod]` | 头部前倾（点头） | 表示赞同、回答"是" |
| `[ACTION:shake]` | 头部左右转（摇头） | 表示否定、回答"不" |
| `[ACTION:tilt_left]` | 头部向左倾斜 | 思考、好奇 |
| `[ACTION:tilt_right]` | 头部向右倾斜 | 俏皮、考虑中 |
| `[ACTION:look_up]` | 头部抬起 | 惊讶、兴奋 |
| `[ACTION:look_down]` | 头部低垂 | 沮丧、专注 |
| `[ACTION:antenna_wave]` | 双侧天线上下摆动 | 打招呼、庆祝 |
| `[ACTION:spin]` | 机身旋转 360° | 非常兴奋、炫技 |

---

## 连接 Reachy Mini 实体机器人

### 前提条件

| 条件 | 说明 |
|------|------|
| Reachy Mini 已上电并联网 | Lite 版通过 USB 连接；Wireless 版通过 WiFi |
| 机器人 daemon 正在运行 | 一般开机自启，确认 GStreamer webrtcsink 进程存活 |
| HF 账户已获得机器人访问权限 | 联系机器人所有者在 HF 上授权你的账户 |
| 本地信令桥已启动 | `python3 local_signaling_bridge.py` |

### 步骤

**① 启动所有服务**

```bash
# 终端 1
npm run dev

# 终端 2
python3 local_signaling_bridge.py
```

**② 登录 Hugging Face**

打开 `http://localhost:5173`，Host Shell 会进入 HF OAuth 登录或直接以 `HF_TOKEN` 免密登录。

> 本地填好 `.env.local` 中的 `HF_TOKEN` + `HF_USERNAME` 可跳过 OAuth，直接以 devToken 登录。

**③ 在 Robot Picker 中选择机器人**

登录后显示可用机器人列表（在线显示绿点），点击目标机器人，等待 WebRTC 连接（约 3–8 秒）。

**④ 开始对话**

连接成功后进入聊天界面，可切换 Text / Realtime 两种模式。

**⑤ 离开会话**

点击 Host Shell 顶部「退出」，机器人自动归位，WebRTC 安全断开。

---

## 生产部署（Hugging Face Spaces）

```bash
git add .
git commit -m "deploy"
git push
```

在 HF Space **Settings → Repository secrets** 中添加：

```
HERMES_URL    = https://hermes-api.aiforce.dev
HERMES_KEY    = <你的 API Key>
CF_AI_TOKEN   = <Cloudflare AI Gateway Token>
CF_ACCOUNT_ID = <Cloudflare Account ID>
CF_GATEWAY_ID = <Cloudflare Gateway ID>
HERMES_GOOGLE_API_KEY = <Google AI Studio Key>
```

HF 会自动运行 `npm install && npm run build` 并将 `dist/` 作为静态站点提供服务。

---

## 故障排查

### ❌ 显示 "Couldn't reach Hugging Face"（机器人列表空白）

**原因**：本地信令桥未启动。

```bash
# 确认解法
python3 local_signaling_bridge.py   # 终端 2 中启动

# 验证
curl http://localhost:9090/api/robot-status
```

详见 [`docs/troubleshooting-robot-list.md`](docs/troubleshooting-robot-list.md)。

### ❌ 显示 "No Reachy online"（列表空，但桥已启动）

**原因**：HF OAuth Token 缺少 Space 上下文，信令服务器过滤了机器人。

| 认证方式 | 可见机器人 |
|----------|------------|
| PAT（`hf_xxx`）| 仅你**自己拥有**的机器人 |
| HF OAuth Token | 共享给你所在 Space 的所有机器人 |

**修复**：创建 HF OAuth 应用并填入 `HF_OAUTH_CLIENT_ID`：

1. 前往 [HF OAuth 应用管理](https://huggingface.co/settings/applications/new)：
   - **Homepage URL** + **Redirect URI**：`http://localhost:5173`
   - **Scopes**：`openid` + `profile`
2. 复制 Client ID 填入 `.env.local`
3. 联系机器人所有者将你的 Space 加入共享列表
4. 重启 `npm run dev`，进行 OAuth 授权

### ❌ Realtime 模式无响应

**排查清单**：

| # | 检查项 | 方法 |
|---|--------|------|
| 1 | `.env.local` 中 Cloudflare 变量是否填写 | 检查 `CF_AI_TOKEN` / `CF_ACCOUNT_ID` / `CF_GATEWAY_ID` |
| 2 | Gemini Live WebSocket 是否连接成功 | DevTools → Network → WS，看 `/gemini-live` 连接 |
| 3 | 浏览器麦克风权限 | 地址栏左侧，确认麦克风已授权 |
| 4 | Smoke test | `node scripts/test-gemini-live.mjs --direct` |

### ❌ 信令桥 Python 依赖缺失

```bash
pip install aiohttp websockets
```

---

## 开发工具

### Smoke Tests

```bash
# 测试 Gemini Live API 基础连通性（直连 Google）
node scripts/test-gemini-live.mjs --direct

# 测试 Function Calling + 图片输入（直连 Google）
node scripts/test-live-tools.mjs --direct

# 通过 Cloudflare AI Gateway 测试
node scripts/test-gemini-live.mjs
node scripts/test-live-tools.mjs

# 测试 Hermes API
curl https://hermes-api.aiforce.dev/v1/chat/completions \
  -H "Authorization: Bearer $HERMES_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"hermes-agent","messages":[{"role":"user","content":"你好，点个头！"}],"stream":false}' \
  | python3 -m json.tool
```

### 信令桥验证

```bash
# 桥是否在线
lsof -i :9090

# 机器人状态
curl -s http://localhost:9090/api/robot-status | python3 -m json.tool
```

---

## 相关文件

| 文件 | 作用 |
|------|------|
| `local_signaling_bridge.py` | HTTP ↔ WebSocket 信令桥，本地开发连接真实机器人 |
| `src/embed.ts` | 主应用入口，Text / Realtime 模式管理 |
| `src/gemini-live.ts` | Gemini Live WebSocket 客户端（音频、Function Calling） |
| `src/realtime-tools.ts` | Realtime 模式工具声明（`robot_action` / `capture_camera`） |
| `src/hermes.ts` | Hermes Agent SSE 对话客户端 |
| `src/actions.ts` | 机器人动作执行器（Text 模式 `[ACTION:xxx]` 解析） |
| `src/audio-pipeline.ts` | 音频采集（48kHz → 16kHz 重采样）+ 播放 |
| `scripts/test-gemini-live.mjs` | Gemini Live API smoke test |
| `scripts/test-live-tools.mjs` | Function Calling + 图片输入 smoke test |
| `docs/troubleshooting-robot-list.md` | 机器人列表故障详细排查 |
| `.env.local.example` | 环境变量模板 |
