# AIStudio Manager

AIStudio Manager 是一个强大的 Google AI Studio 账号管理和 API 代理系统，提供多账号切换、流量统计、Token 消耗分析等功能。

## 主要功能

- **多账号管理**: 管理多个 Google AI Studio 账号，支持实时切换
- **API 代理**: 代理 Google Generative AI API 请求，支持流式和非流式模式
- **智能切换**: 根据错误率或使用次数自动切换账号
- **流量统计**: 实时记录和分析 API 调用流量
- **Token 分析**: 按模型统计 Input/Output Token 消耗，生成详细报告
- **配置管理**: 灵活的 YAML 配置系统，支持环境变量覆盖
- **Web 界面**: 基于 Tauri + React 的现代化桌面管理界面

## 项目结构

```
AIStudio2API/
├── auth
├── black-browser.js
├── config-loader.js
├── config-manager.js
├── config.yml
├── LICENSE
├── models.json
├── package.json
├── pnpm-lock.yaml
├── README.md
├── save-auth.js
├── tauri-app
│   ├── index.html
│   ├── package.json
│   ├── pnpm-lock.yaml
│   ├── pnpm-workspace.yaml
│   ├── postcss.config.js
│   ├── src
│   │   ├── App.tsx
│   │   ├── components
│   │   │   └── Layout.tsx
│   │   ├── index.css
│   │   ├── lib
│   │   │   ├── api.ts
│   │   │   └── utils.ts
│   │   ├── main.tsx
│   │   └── pages
│   │       ├── Accounts.tsx
│   │       ├── Config.tsx
│   │       ├── Dashboard.tsx
│   │       ├── Logs.tsx
│   │       ├── TokenStats.tsx
│   │       └── Traffic.tsx
│   ├── src-tauri
│   │   ├── build.rs
│   │   ├── Cargo.lock
│   │   ├── Cargo.toml
│   │   ├── gen
│   │   │   └── schemas
│   │   │       ├── acl-manifests.json
│   │   │       ├── capabilities.json
│   │   │       ├── desktop-schema.json
│   │   │       └── linux-schema.json
│   │   ├── icons
│   │   │   ├── 128x128@2x.png
│   │   │   ├── 128x128.png
│   │   │   ├── 32x32.png
│   │   │   ├── icon.icns
│   │   │   ├── icon.ico
│   │   │   ├── icon.png
│   │   │   └── Square512x512Logo.png
│   │   ├── src
│   │   │   ├── lib.rs
│   │   │   └── main.rs
│   │   └── tauri.conf.json
│   ├── start.sh
│   ├── tailwind.config.js
│   ├── tsconfig.json
│   ├── tsconfig.node.json
│   └── vite.config.ts
└── unified-server.js
```

## 快速开始

### 前置要求

- Node.js 16+
- pnpm
- Rust (仅用于构建 Tauri)

### 安装步骤

1. 克隆项目并安装依赖

```bash
git clone https://github.com/LemonFan-maker/AIStudio2API.git
cd AIStudio2API
pnpm install

cp .config.yml config.yml
```


1. 启动后端服务

```bash
node server.js
```

服务器将在 `http://localhost:7860` 启动。

4. 启动前端应用

```bash
cd tauri-app
pnpm tauri dev
```

## 配置说明

### config.yml 配置选项

```yaml
server:
  httpPort: 7860          # HTTP 服务端口
  host: 0.0.0.0          # 监听地址
  wsPort: 9998           # WebSocket 端口

streaming:
  mode: real             # real 或 fake

features:
  forceThinking: false   # 强制启用思维推理
  forceWebSearch: false  # 强制启用联网搜索
  forceUrlContext: false # 强制上传 URL 上下文

accountSwitching:
  failureThreshold: 3    # 失败次数阈值
  switchOnUses: 40       # 使用次数阈值
  immediateSwitchStatusCodes: [429, 503]

retry:
  maxRetries: 1          # 最大重试次数
  retryDelay: 2000       # 重试延迟（毫秒）

concurrency:
  maxConcurrentRequests: 3

browser:
  executablePath: null   # Firefox 可执行路径
  initialAuthIndex: 1    # 初始账号索引

apiKeys:
  - your-api-key-here

models:
  - gemini-1.5-pro-latest
```

### 环境变量

支持以下环境变量覆盖配置：

- `PORT` - HTTP 服务端口
- `HOST` - 监听地址
- `STREAMING_MODE` - 流式模式
- `API_KEYS` - 逗号分隔的 API Key
- `FAILURE_THRESHOLD` - 失败阈值
- `SWITCH_ON_USES` - 切换阈值
- `MAX_RETRIES` - 最大重试次数
- `INITIAL_AUTH_INDEX` - 初始账号索引
- `FORCE_THINKING` - 强制思维推理
- `FORCE_WEB_SEARCH` - 强制联网搜索

## 使用指南

### 添加账号

1. 运行 `save-auth.js` 脚本采集账号信息
2. 在 Web 界面"账号管理"页面上传 storageState.json
3. 系统自动验证并保存账号

### 管理 API Key

1. 打开"配置"页面
2. 输入 API Key（默认为 123456）
3. 系统自动验证并保存

### 查看统计数据

- **仪表盘**: 实时系统状态和快速统计
- **流量统计**: 按时间线查看 API 调用记录
- **Token 统计**: 按模型分析 Token 消耗情况，包括趋势图表

### API 端点

#### 系统端点

- `GET /api/status` - 获取系统状态
- `GET /api/config` - 获取配置
- `POST /api/config` - 更新配置
- `POST /api/save-config` - 保存配置到文件
- `GET /api/models` - 获取支持的模型列表

#### 账号端点

- `GET /api/auth/status` - 获取账号状态
- `POST /api/auth/upload` - 上传新账号
- `POST /api/auth/switch/:index` - 切换账号

#### 流量端点

- `GET /api/traffic/logs` - 获取流量日志
- `GET /api/traffic/summary` - 获取流量摘要

#### 代理端点

- `POST /v1beta/models/:model/generateContent` - 调用 API

## 工作原理

### 账号切换流程

1. 系统记录每个账号的使用情况（错误率、调用次数）
2. 当账号达到失败阈值或使用次数阈值时触发切换
3. 自动切换到可用的下一个账号
4. 特定 HTTP 状态码（如 429、503）导致立即切换

### 流量记录

系统记录以下信息：
- 请求时间戳
- 使用的模型
- 账号索引
- HTTP 状态码
- Input/Output Token 消耗

### Token 消耗计算

从 API 响应中提取 `usageMetadata`：
- `promptTokenCount` - Input Token
- `candidatesTokenCount` - Output Token

## 故障排除

### 连接失败

检查后端是否正常运行：
```bash
curl http://localhost:7860/api/status
```

### API Key 无效

确保 API Key 正确配置，并有有效的 Google AI Studio 账号。

### 账号切换不工作

1. 检查 `auth/` 目录下是否有账号文件
2. 检查切换阈值配置
3. 查看日志了解具体错误

### 流量统计显示为 0

确保请求包含有效的 Token 使用元数据。后端会自动从流式响应中提取。

## 开发

### 本地开发

前端：
```bash
cd tauri-app
pnpm dev
```

后端：
```bash
node server.js
```

### 构建生产版本

前端：
```bash
cd tauri-app
pnpm build
```

## 许可证

MIT

## 支持

遇到问题？提交 Issue 或查看日志获取更多信息。

日志位置：
- 后端：控制台输出和 `server.js` 日志
- 前端：浏览器开发者工具控制台
