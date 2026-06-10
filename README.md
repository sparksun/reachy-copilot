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

基于自托管 [Hermes Agent](https://hermes-agent.nousresearch.com/) 的 Reachy Mini 对话式 AI 控制界面。

## 功能

- 💬 流式接收 Hermes Agent 的实时回复（SSE 串流）
- 🎤 语音输入（浏览器 Web Speech API，无需额外服务）
- 🤖 AI 回复中嵌入动作标签，实时驱动机器人肢体反应（点头、摇头、天线挥动等）
- 🌙 深色优先、移动端响应式界面

---

## 本地开发

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

```bash
cp .env.local.example .env.local
```

编辑 `.env.local`，填入以下值：

| 变量 | 说明 |
|------|------|
| `HF_TOKEN` | HF 个人访问令牌（在 [HF Settings](https://huggingface.co/settings/tokens) 生成，read 权限即可） |
| `HF_USERNAME` | 你的 HF 用户名（如 `sparkunt`） |
| `HERMES_URL` | Hermes Agent API 地址（如 `https://hermes-api.aiforce.dev`） |
| `HERMES_KEY` | Hermes `API_SERVER_KEY` 的值 |

### 3. 启动开发服务器

```bash
npm run dev
# → 浏览器打开 http://localhost:5173
```

---

## 模拟环境测试（无实体机器人）

本应用的 UI 层与机器人控制层解耦，可在不连接真实机器人的情况下单独验证 Hermes 对话与 UI 逻辑。

### 方式一：直接测试 Hermes 对话流

在浏览器直接访问 `http://localhost:5173`，Host Shell 会引导你登录 HF 并选择机器人。若**暂无机器人**，可跳过连接步骤，通过以下方式验证 Hermes 接口连通性：

```bash
# 测试 Hermes API 是否正常响应
curl https://hermes-api.aiforce.dev/v1/chat/completions \
  -H "Authorization: Bearer $HERMES_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"hermes-agent","messages":[{"role":"user","content":"你好，点个头！"}],"stream":false}' \
  | python3 -m json.tool
```

正常返回 JSON 且 `choices[0].message.content` 包含 `[ACTION:nod]` 即表示 Hermes + System Prompt 配置正确。

### 方式二：绕过 Host Shell，直接加载嵌入模式

在 URL 加 `?embedded=1` 可跳过机器人连接，直接加载 App 的嵌入 iframe（**无机器人动作**，但可测试 UI 和 Hermes 通信）：

```
http://localhost:5173?embedded=1
```

> ⚠️ 此模式下 `connectToHost()` 会超时后降级运行，动作执行会静默失败——适合纯 UI / 对话逻辑调试。

### 方式三：使用 Reachy Mini 模拟器（如果可用）

如果你安装了 Pollen Robotics 提供的仿真环境（Webots / Isaac Sim + reachy_mini 包），可在仿真中运行 daemon，然后在 HF Robot Picker 中选择仿真机器人，App 会像连接真实机器人一样工作。

---

## 连接 Reachy Mini 实体机器人

### 前提条件

| 条件 | 说明 |
|------|------|
| Reachy Mini 已上电并联网 | Lite 版通过 USB 连接电脑；Wireless 版通过 WiFi |
| 机器人 daemon 正在运行 | 一般开机自启，确认 WebRTC daemon 进程存活 |
| HF 账户已获得机器人访问权限 | 联系机器人所有者在 HF 上授权你的账户 |

### 步骤

**① 启动应用**

```bash
npm run dev   # 本地开发
# 或访问已部署的 HF Space URL
```

**② 登录 Hugging Face**

打开 `http://localhost:5173`，Host Shell 会自动跳转至 HF OAuth 登录页，授权后返回应用。

> 本地开发时填好 `.env.local` 中的 `HF_TOKEN` + `HF_USERNAME` 可跳过 OAuth，直接以 devToken 登录。

**③ 在 Robot Picker 中选择你的机器人**

登录后 Host Shell 顶部会显示可用机器人列表（在线机器人显示绿点）。点击目标机器人，等待 WebRTC 连接建立（约 3–8 秒）。

**④ 开始对话**

连接成功后进入聊天界面：
- **文字输入**：在底部文本框输入后按 Enter 或点击发送
- **语音输入**：点击 🎤 按钮后说话，识别完成后自动发送

Hermes 回复中的动作标签会**立即**触发机器人物理动作，同时在顶部显示动作提示 chip。

### 动作词汇表

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

### 离开会话

点击 Host Shell 顶部的「退出」按钮，机器人会自动归位（头部归零、天线收回），WebRTC 连接安全断开。

---

## 生产部署（Hugging Face Spaces）

```bash
git add .
git commit -m "initial release"
git push
```

在 HF Space **Settings → Repository secrets** 中添加：

```
HERMES_URL = https://hermes-api.aiforce.dev
HERMES_KEY = <你的 API Key>
```

HF 会自动运行 `npm install && npm run build` 并将 `dist/` 作为静态站点提供服务。

---

## 故障排查

### ❌ 显示 "No Reachy online"（机器人不出现）

#### 根本原因

Reachy Mini 的信令服务器（`pollen-robotics-reachy-mini-central.hf.space`）通过 **HF OAuth token 中携带的 Space 上下文** 来过滤可见机器人列表。

- **官方 App**（`pollen-robotics/reachy_mini_minimal_conversation`）通过 HF OAuth 登录，OAuth token 中携带了 Space ID → 信令服务器知道哪些机器人被共享给该 Space → 机器人出现 ✅
- **本地 PAT 模式**（`HF_TOKEN` 个人访问令牌）没有 Space 上下文 → 信令服务器返回 `producers: []` → 没有机器人 ❌

可以用以下命令自行验证：

```bash
# 结果应为 {"robots": []} 或 producers: []
curl "https://pollen-robotics-reachy-mini-central.hf.space/api/robot-status" \
  -H "Authorization: Bearer $HERMES_KEY"
```

#### 修复路径（二选一）

**✅ 推荐：本地 OAuth 模式（立即可用）**

1. 前往 [HF OAuth 应用管理](https://huggingface.co/settings/applications/new) 创建新应用：
   - **Homepage URL**：`http://localhost:5173`
   - **Redirect URI**：`http://localhost:5173`
   - **Scopes**：勾选 `openid` 和 `profile`
2. 复制生成的 **Client ID**，填入 `.env.local`：

   ```
   HF_OAUTH_CLIENT_ID=<你的 Client ID>
   ```

3. **同时联系机器人所有者**，将你的新 Space（部署后的 `username/reachy-copilot`）添加到机器人的共享列表。

4. 重启 `npm run dev`，打开 `http://localhost:5173`，此时会进行真正的 OAuth 授权流程，授权后机器人应可见。

**✅ 备选：先部署到 HF Spaces，再测试**

1. 将代码推送到 HF Spaces（`git push`）
2. 在 Space 设置页面获取自动生成的 OAuth Client ID
3. 请机器人所有者在机器人管理页将你的 Space ID（`username/reachy-copilot`）加入共享列表
4. 从 Space URL 访问 App，机器人即可出现

#### 为什么 PAT 不行，OAuth 可以？

| 认证方式 | Token 携带信息 | 信令服务器行为 |
|----------|---------------|--------------|
| PAT（`hf_xxx`）| 仅用户身份 | 只能看到该用户**自己拥有**的机器人 |
| HF OAuth Token | 用户身份 + **Space ID** | 能看到共享给该 Space 的所有机器人 |

如果你亲自拥有机器人（不是别人共享的），PAT 也能工作——直接把 `HF_TOKEN` 填好即可，无需 OAuth。
