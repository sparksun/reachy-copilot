# 故障排查：本地开发模式下机器人列表无法加载

> **症状**：`npm run dev` 启动后访问 `http://localhost:5173/`，页面显示  
> **"Couldn't reach Hugging Face"**，机器人列表始终为空，无法进入会话。

---

## 根因分析

### 1. 错误来源

该错误并非来自项目代码，而是 SDK 内部的 robot picker 组件
（`@pollen-robotics/reachy-mini-sdk/host/dist/chunks/mountHost-*.js`）。

当 SDK 向信令服务器请求机器人列表失败时，会渲染此错误界面：

```
robots 为空 && 非刷新中 && error 存在
  → 显示 "Couldn't reach Hugging Face"（subtitle = 具体错误信息）
```

### 2. 本地开发的信令路由

在 `index.html` 中，当检测到本地开发环境（`__OAUTH_CLIENT_ID__` 未被 HF Spaces 替换）时，
会将 SDK 的信令地址指向本地桥接服务：

```javascript
// index.html 第 70-82 行
window.huggingface.variables.SIGNALING_URL = 'http://localhost:9090';
```

SDK host shell 会向该地址发起两个关键请求：

| 端点 | 用途 |
|------|------|
| `GET /api/robot-status` | 获取可用机器人列表 |
| `GET /events` | SSE 长连接，接收实时状态更新 |

### 3. 直接原因

`local_signaling_bridge.py`（监听 `localhost:9090`）**未启动**。

SDK 请求 `localhost:9090` 时收到 `ERR_CONNECTION_REFUSED`，
错误被 SDK 捕获后显示为 "Couldn't reach Hugging Face"。

### 4. 架构示意

```
┌─────────────────────────────────────────────────────────┐
│  浏览器 (localhost:5173)                                 │
│                                                         │
│  ┌──────────────┐    iframe    ┌──────────────────────┐  │
│  │ SDK Host     │ ──────────→ │ embed.ts (Copilot)   │  │
│  │ (mountHost)  │             │ ├── hermes.ts         │  │
│  │ OAuth/Picker │             │ └── actions.ts        │  │
│  └──────┬───────┘             └──────────────────────┘  │
│         │                                               │
└─────────┼───────────────────────────────────────────────┘
          │ HTTP (信令协议)
          ▼
┌──────────────────────┐         ┌─────────────────────┐
│ local_signaling_     │  WS     │ GStreamer webrtcsink │
│ bridge.py (:9090)    │ ──────→ │ (ws://127.0.0.1:    │
│ HTTP ↔ WebSocket     │         │       8443)          │
└──────────────────────┘         └─────────────────────┘
```

本地开发需要 **三层服务同时运行**：

1. **Vite dev server** (`npm run dev`) → `:5173`
2. **Local signaling bridge** (`python3 local_signaling_bridge.py`) → `:9090`
3. **GStreamer webrtcsink**（机器人端） → `:8443`

缺少第 2 层即会触发本文档记录的错误。

---

## 解决方案

### 快速修复

同时启动 Vite 和信令桥：

```bash
# 终端 1：前端
npm run dev

# 终端 2：信令桥
python3 local_signaling_bridge.py
```

### 验证桥接服务正常

```bash
curl -s http://localhost:9090/api/robot-status | python3 -m json.tool
```

预期输出（GStreamer 在线时）：

```json
{
    "robots": [
        {
            "peerId": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
            "robotName": "reachy_mini",
            "busy": false,
            "activeApp": null,
            "meta": { "name": "reachy_mini" },
            "last_seen_age_seconds": 1.0
        }
    ]
}
```

GStreamer 不在线时返回 `{"robots": []}`，此时页面会显示 "No Reachy online"（正常状态）。

### 依赖检查

信令桥依赖两个 Python 包：

```bash
python3 -c "import aiohttp; import websockets; print('ok')"
```

若缺失，安装：

```bash
pip install aiohttp websockets
```

---

## 排查清单

遇到 "Couldn't reach Hugging Face" 时，按以下顺序检查：

| # | 检查项 | 命令 |
|---|--------|------|
| 1 | 信令桥是否在运行 | `lsof -i :9090` |
| 2 | 信令桥是否可达 | `curl http://localhost:9090/api/robot-status` |
| 3 | GStreamer 是否在运行 | `lsof -i :8443` |
| 4 | HF Token 是否有效 | `curl -s https://huggingface.co/api/whoami-v2 -H "Authorization: Bearer $(grep HF_TOKEN .env.local \| cut -d= -f2)"` |
| 5 | 浏览器控制台错误 | DevTools → Console，查找 `ERR_CONNECTION_REFUSED` |

---

## 相关文件

| 文件 | 作用 |
|------|------|
| `index.html` (L70-82) | 本地开发时注入 `SIGNALING_URL=http://localhost:9090` |
| `local_signaling_bridge.py` | HTTP ↔ WebSocket 信令桥，端口 9090 |
| `src/dispatch.ts` | 入口路由，standalone 模式调用 `mountHost()` |
| `.env.local` | `HF_TOKEN` / `HF_USERNAME` 配置（PAT 认证） |
| `vite.config.ts` | `envPrefix` 配置，暴露 `HF_*` / `HERMES_*` 环境变量 |
