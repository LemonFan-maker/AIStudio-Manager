/**
 * 代理服务器系统模块
 * 主系统类，负责协调所有组件
 */

const { EventEmitter } = require("events");
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const session = require("express-session");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { LoggingService } = require("./logging-service");
const { AuthSource } = require("./auth-source");
const { BrowserManager } = require("./browser-manager");
const { ConnectionRegistry } = require("./connection-registry");
const { RequestHandler } = require("./request-handler");
const { loadConfiguration } = require("../config-loader");
const { readConfig, saveConfig } = require("../config-manager");

// 获取项目根目录
const ROOT_DIR = path.join(__dirname, "..");

class ProxyServerSystem extends EventEmitter {
    constructor() {
        super();
        this.logger = new LoggingService("ProxySystem");

        // 使用配置加载器
        this.config = loadConfiguration(this.logger);

        this.streamingMode = this.config.streamingMode;
        this.forceThinking = this.config.forceThinking;
        this.forceWebSearch = this.config.forceWebSearch;
        this.forceUrlContext = this.config.forceUrlContext;

        this.authSource = new AuthSource(this.logger);
        this.browserManager = new BrowserManager(
            this.logger,
            this.config,
            this.authSource
        );
        this.connectionRegistry = new ConnectionRegistry(this.logger);
        this.requestHandler = new RequestHandler(
            this,
            this.connectionRegistry,
            this.logger,
            this.browserManager,
            this.config,
            this.authSource
        );

        this.httpServer = null;
        this.wsServer = null;
    }

    async start(initialAuthIndex = null) {
        this.logger.info("[System] 开始弹性启动流程...");
        await this._startHttpServer();
        await this._startWebSocketServer();

        const allAvailableIndices = this.authSource.availableIndices;

        if (allAvailableIndices.length === 0) {
            this.logger.warn(
                "[System] 没有任何可用的认证源，服务器将以管理模式启动（代理功能不可用）。"
            );
            this.logger.info("[System] 请通过 /api/upload-auth 上传认证文件以启用代理功能。");
            this.logger.info(`[System] 代理服务器管理面板已启动完成。`);
            this.emit("started");
            return;
        }

        this.logger.info("[System] 准备加载浏览器...");

        // 创建优先尝试的启动顺序列表
        let startupOrder = [...allAvailableIndices];
        if (initialAuthIndex && allAvailableIndices.includes(initialAuthIndex)) {
            this.logger.info(`[System] 检测到指定启动索引 #${initialAuthIndex}，将优先尝试。`);
            startupOrder = [
                initialAuthIndex,
                ...allAvailableIndices.filter((i) => i !== initialAuthIndex),
            ];
        } else {
            if (initialAuthIndex) {
                this.logger.warn(
                    `[System] 指定的启动索引 #${initialAuthIndex} 无效或不可用，将按默认顺序启动。`
                );
            }
            this.logger.info(`[System] 未指定有效启动索引，将按默认顺序 [${startupOrder.join(", ")}] 尝试。`);
        }

        let isStarted = false;
        for (const index of startupOrder) {
            try {
                this.logger.info(`[System] 尝试使用账号 #${index} 启动服务...`);
                await this.browserManager.launchOrSwitchContext(index);
                isStarted = true;
                this.logger.info(`[System] 使用账号 #${index} 成功启动！`);
                break;
            } catch (error) {
                this.logger.error(`[System] 使用账号 #${index} 启动失败。原因: ${error.message}`);
            }
        }

        if (!isStarted) {
            throw new Error("所有认证源均尝试失败，服务器无法启动。");
        }
        this.logger.info(`[System] 代理服务器系统启动完成。`);
        this.emit("started");
    }

    _createAuthMiddleware() {
        return (req, res, next) => {
            const serverApiKeys = this.config.apiKeys;
            if (!serverApiKeys || serverApiKeys.length === 0) {
                return next();
            }

            let clientKey = null;
            if (req.headers["x-goog-api-key"]) {
                clientKey = req.headers["x-goog-api-key"];
            } else if (req.headers.authorization && req.headers.authorization.startsWith("Bearer ")) {
                clientKey = req.headers.authorization.substring(7);
            } else if (req.headers["x-api-key"]) {
                clientKey = req.headers["x-api-key"];
            } else if (req.query.key) {
                clientKey = req.query.key;
            }

            if (clientKey && serverApiKeys.includes(clientKey)) {
                this.logger.info(`[Auth] API Key验证通过 (来自: ${req.headers["x-forwarded-for"] || req.ip})`);
                if (req.query.key) delete req.query.key;
                return next();
            }

            if (req.path !== "/favicon.ico") {
                const clientIp = req.headers["x-forwarded-for"] || req.ip;
                this.logger.warn(`[Auth] 访问密码错误或缺失，已拒绝请求。IP: ${clientIp}, Path: ${req.path}`);
            }

            return res.status(401).json({
                error: { message: "Access denied. A valid API key was not found or is incorrect." },
            });
        };
    }

    async _startHttpServer() {
        const app = this._createExpressApp();
        this.httpServer = http.createServer(app);

        this.httpServer.keepAliveTimeout = 120000;
        this.httpServer.headersTimeout = 125000;
        this.httpServer.requestTimeout = 120000;

        return new Promise((resolve) => {
            this.httpServer.listen(this.config.httpPort, this.config.host, () => {
                this.logger.info(
                    `[System] HTTP服务器已在 http://${this.config.host}:${this.config.httpPort} 上监听`
                );
                this.logger.info(`[System] Keep-Alive 超时已设置为 ${this.httpServer.keepAliveTimeout / 1000} 秒。`);
                resolve();
            });
        });
    }

    _createExpressApp() {
        const app = express();

        // CORS 中间件
        app.use((req, res, next) => {
            res.header("Access-Control-Allow-Origin", "*");
            res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
            res.header(
                "Access-Control-Allow-Headers",
                "Content-Type, Authorization, x-requested-with, x-api-key, x-goog-api-key, x-goog-api-client, x-user-agent," +
                " origin, accept, baggage, sentry-trace, openai-organization, openai-project, openai-beta, x-stainless-lang, " +
                "x-stainless-package-version, x-stainless-os, x-stainless-arch, x-stainless-runtime, x-stainless-runtime-version, " +
                "x-stainless-retry-count, x-stainless-timeout, sec-ch-ua, sec-ch-ua-mobile, sec-ch-ua-platform"
            );
            if (req.method === "OPTIONS") {
                return res.sendStatus(204);
            }
            next();
        });

        // 日志中间件
        app.use((req, res, next) => {
            if (
                req.path !== "/api/status" &&
                req.path !== "/" &&
                req.path !== "/favicon.ico" &&
                req.path !== "/login"
            ) {
                this.logger.info(`[Entrypoint] 收到一个请求: ${req.method} ${req.path}`);
            }
            next();
        });

        app.use(express.json({ limit: "100mb" }));
        app.use(express.urlencoded({ extended: true }));

        // Session 设置
        const sessionSecret =
            (this.config.apiKeys && this.config.apiKeys[0]) || crypto.randomBytes(20).toString("hex");
        app.use(cookieParser());
        app.use(
            session({
                secret: sessionSecret,
                resave: false,
                saveUninitialized: true,
                cookie: { secure: false, maxAge: 86400000 },
            })
        );

        // 认证中间件
        const isAuthenticated = (req, res, next) => {
            if (req.session.isAuthenticated) {
                return next();
            }

            const hasValidKeys =
                this.config.apiKeys &&
                this.config.apiKeys.length > 0 &&
                this.config.apiKeys.some((k) => k && String(k).trim() !== "");

            if (!hasValidKeys && req.path.startsWith("/api/config")) {
                this.logger.info(`[Auth] 系统未初始化，临时允许 ${req.method} ${req.path} 请求以进行设置`);
                return next();
            }

            const apiKey = req.headers["x-api-key"];
            if (apiKey && this.config.apiKeys.includes(apiKey)) {
                return next();
            }

            const acceptHeader = req.headers.accept || "";
            if (acceptHeader.includes("application/json") || req.path.startsWith("/api/")) {
                return res.status(401).json({ error: { message: "未授权：请提供有效的 API Key" } });
            } else {
                res.redirect("/login");
            }
        };

        // 登录路由
        this._setupLoginRoutes(app, isAuthenticated);

        // API 路由
        this._setupAPIRoutes(app, isAuthenticated);

        // 使用 API Key 中间件进行代理请求认证
        app.use(this._createAuthMiddleware());

        // OpenAI 兼容路由
        app.get("/v1/models", (req, res) => {
            const modelIds = this.config.modelList || ["gemini-2.5-pro"];
            const models = modelIds.map((id) => ({
                id: id,
                object: "model",
                created: Math.floor(Date.now() / 1000),
                owned_by: "google",
            }));
            res.status(200).json({ object: "list", data: models });
        });

        app.post("/v1/chat/completions", (req, res) => {
            this.requestHandler.processOpenAIRequest(req, res);
        });

        // 代理所有其他请求
        app.all(/^(?!\/api\/)(.*)/, (req, res) => {
            this.requestHandler.processRequest(req, res);
        });

        return app;
    }

    _setupLoginRoutes(app, isAuthenticated) {
        app.get("/login", (req, res) => {
            if (req.session.isAuthenticated) {
                return res.redirect("/");
            }
            const loginHtml = `
      <!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>登录</title>
      <style>body{display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;background:#f0f2f5}form{background:white;padding:40px;border-radius:10px;box-shadow:0 4px 8px rgba(0,0,0,0.1);text-align:center}input{width:250px;padding:10px;margin-top:10px;border:1px solid #ccc;border-radius:5px}button{width:100%;padding:10px;background-color:#007bff;color:white;border:none;border-radius:5px;margin-top:20px;cursor:pointer}.error{color:red;margin-top:10px}</style>
      </head><body><form action="/login" method="post"><h2>请输入 API Key</h2>
      <input type="password" name="apiKey" placeholder="API Key" required autofocus><button type="submit">登录</button>
      ${req.query.error ? '<p class="error">API Key 错误!</p>' : ""}</form></body></html>`;
            res.send(loginHtml);
        });

        app.post("/login", (req, res) => {
            const { apiKey } = req.body;
            if (apiKey && this.config.apiKeys.includes(apiKey)) {
                req.session.isAuthenticated = true;
                res.redirect("/");
            } else {
                res.redirect("/login?error=1");
            }
        });

        // 状态页面
        app.get("/", isAuthenticated, (req, res) => {
            this._sendStatusPage(req, res);
        });
    }

    _setupAPIRoutes(app, isAuthenticated) {
        // 状态 API
        app.get("/api/status", isAuthenticated, (req, res) => {
            const { config, requestHandler, authSource, browserManager } = this;
            const initialIndices = authSource.initialIndices || [];
            const invalidIndices = initialIndices.filter((i) => !authSource.availableIndices.includes(i));
            const logs = this.logger.logBuffer || [];
            const accountNameMap = authSource.accountNameMap;
            const accountDetails = initialIndices.map((index) => {
                const isInvalid = invalidIndices.includes(index);
                const name = isInvalid ? "N/A (JSON格式错误)" : accountNameMap.get(index) || "N/A (未命名)";
                return { index, name };
            });

            const data = {
                status: {
                    streamingMode: `${this.streamingMode} (仅启用流式传输时生效)`,
                    maxConcurrentRequests: config.maxConcurrentRequests,
                    activeRequests: requestHandler.activeRequests,
                    pendingRequests: requestHandler.pendingRequests.length,
                    forceThinking: this.forceThinking ? "已启用" : "已关闭",
                    forceWebSearch: this.forceWebSearch ? "已启用" : "已关闭",
                    forceUrlContext: this.forceUrlContext ? "已启用" : "已关闭",
                    browserConnected: !!browserManager.browser,
                    immediateSwitchStatusCodes:
                        config.immediateSwitchStatusCodes.length > 0
                            ? `[${config.immediateSwitchStatusCodes.join(", ")}]`
                            : "已禁用",
                    apiKeySource: config.apiKeySource,
                    currentAuthIndex: requestHandler.currentAuthIndex,
                    usageCount: `${requestHandler.usageCount} / ${config.switchOnUses > 0 ? config.switchOnUses : "N/A"}`,
                    failureCount: `${requestHandler.failureCount} / ${config.failureThreshold > 0 ? config.failureThreshold : "N/A"
                        }`,
                    initialIndices: `[${initialIndices.join(", ")}] (总数: ${initialIndices.length})`,
                    accountDetails: accountDetails,
                    invalidIndices: `[${invalidIndices.join(", ")}] (总数: ${invalidIndices.length})`,
                },
                logs: logs.join("\n"),
                logCount: logs.length,
            };
            res.json(data);
        });

        // 流量统计 API
        app.get("/api/traffic", isAuthenticated, (req, res) => {
            try {
                const trafficData = this.requestHandler.getTrafficStats();
                res.json(trafficData);
            } catch (error) {
                this.logger.error(`[API] 获取流量统计失败: ${error.message}`);
                res.status(500).json({ error: "获取流量统计失败", message: error.message });
            }
        });

        // 模型列表 API
        app.get("/api/models", isAuthenticated, (req, res) => {
            try {
                const modelsPath = path.join(ROOT_DIR, "models.json");
                if (!fs.existsSync(modelsPath)) {
                    return res.status(404).json({ error: "models.json 不存在" });
                }
                const content = fs.readFileSync(modelsPath, "utf-8");
                const models = JSON.parse(content);
                if (!Array.isArray(models)) {
                    return res.status(400).json({ error: "models.json 格式错误" });
                }
                res.json({ models });
            } catch (error) {
                this.logger.error(`[API] 获取模型列表失败: ${error.message}`);
                res.status(500).json({ error: "获取模型列表失败", message: error.message });
            }
        });

        // 切换账号 API
        app.post("/api/switch-account", isAuthenticated, async (req, res) => {
            try {
                const { targetIndex } = req.body;
                if (targetIndex !== undefined && targetIndex !== null) {
                    this.logger.info(`[WebUI] 收到切换到指定账号 #${targetIndex} 的请求...`);
                    const result = await this.requestHandler._switchToSpecificAuth(targetIndex);
                    if (result.success) {
                        res.status(200).send(`切换成功！已激活账号 #${result.newIndex}。`);
                    } else {
                        res.status(400).send(result.reason);
                    }
                } else {
                    this.logger.info("[WebUI] 收到手动切换下一个账号的请求...");
                    if (this.authSource.availableIndices.length <= 1) {
                        return res.status(400).send("切换操作已取消：只有一个可用账号，无法切换。");
                    }
                    const result = await this.requestHandler._switchToNextAuth();
                    if (result.success) {
                        res.status(200).send(`切换成功！已切换到账号 #${result.newIndex}。`);
                    } else if (result.fallback) {
                        res.status(200).send(`切换失败，但已成功回退到账号 #${result.newIndex}。`);
                    } else {
                        res.status(409).send(`操作未执行: ${result.reason}`);
                    }
                }
            } catch (error) {
                res.status(500).send(`致命错误：操作失败！错误: ${error.message}`);
            }
        });

        // 设置模式 API
        app.post("/api/set-mode", isAuthenticated, (req, res) => {
            const newMode = req.body.mode;
            if (newMode === "fake" || newMode === "real") {
                this.streamingMode = newMode;
                this.logger.info(`[WebUI] 流式模式已切换为: ${this.streamingMode}`);
                res.status(200).send(`流式模式已切换为: ${this.streamingMode}`);
            } else {
                res.status(400).send('无效模式. 请用 "fake" 或 "real".');
            }
        });

        // 切换强制推理 API
        app.post("/api/toggle-force-thinking", isAuthenticated, (req, res) => {
            this.forceThinking = !this.forceThinking;
            const statusText = this.forceThinking ? "已启用" : "已关闭";
            this.logger.info(`[WebUI] 强制推理开关已切换为: ${statusText}`);
            res.status(200).send(`强制推理模式: ${statusText}`);
        });

        // 切换强制联网搜索 API
        app.post("/api/toggle-force-web-search", isAuthenticated, (req, res) => {
            this.forceWebSearch = !this.forceWebSearch;
            const statusText = this.forceWebSearch ? "已启用" : "已关闭";
            this.logger.info(`[WebUI] 强制联网搜索开关已切换为: ${statusText}`);
            res.status(200).send(`强制联网搜索: ${statusText}`);
        });

        // 切换强制网址上下文 API
        app.post("/api/toggle-force-url-context", isAuthenticated, (req, res) => {
            this.forceUrlContext = !this.forceUrlContext;
            const statusText = this.forceUrlContext ? "已启用" : "已关闭";
            this.logger.info(`[WebUI] 强制网址上下文开关已切换为: ${statusText}`);
            res.status(200).send(`强制网址上下文: ${statusText}`);
        });

        // 获取配置 API
        app.get("/api/config", isAuthenticated, (req, res) => {
            try {
                const config = readConfig();
                if (!config) {
                    return res.status(404).json({ error: "配置文件不存在" });
                }
                res.json(config);
            } catch (error) {
                this.logger.error(`[API] 读取配置失败: ${error.message}`);
                res.status(500).json({ error: error.message });
            }
        });

        // 保存配置 API
        app.post("/api/config", isAuthenticated, (req, res) => {
            try {
                const newConfig = req.body;
                if (!newConfig || typeof newConfig !== "object") {
                    return res.status(400).json({ error: "无效的配置数据" });
                }
                saveConfig(newConfig);
                this.config = loadConfiguration(this.logger);
                this.streamingMode = this.config.streamingMode;
                this.forceThinking = this.config.forceThinking;
                this.forceWebSearch = this.config.forceWebSearch;
                this.forceUrlContext = this.config.forceUrlContext;
                this.logger.info("[WebUI] 配置已更新并重新加载");
                res.json({ success: true, message: "配置已保存并重新加载" });
            } catch (error) {
                this.logger.error(`[API] 保存配置失败: ${error.message}`);
                res.status(500).json({ error: error.message });
            }
        });

        // 上传认证文件 API
        app.post("/api/upload-auth", isAuthenticated, (req, res) => {
            const { storageState, accountName, targetIndex } = req.body || {};

            if (!storageState) {
                return res.status(400).json({
                    error: { message: "缺少 storageState。请在请求体中提供 storageState 对象或JSON字符串。" },
                });
            }

            let parsedState = storageState;
            if (typeof storageState === "string") {
                try {
                    parsedState = JSON.parse(storageState);
                } catch (e) {
                    return res.status(400).json({
                        error: { message: `storageState 不是合法JSON: ${e.message}` },
                    });
                }
            }

            if (typeof parsedState !== "object" || parsedState === null) {
                return res.status(400).json({
                    error: { message: "storageState 必须是对象或JSON字符串。" },
                });
            }

            if (accountName && typeof accountName === "string") {
                parsedState.accountName = accountName;
            }

            const authDir = path.join(ROOT_DIR, "auth");
            try {
                if (!fs.existsSync(authDir)) {
                    fs.mkdirSync(authDir, { recursive: true });
                }
            } catch (e) {
                return res.status(500).json({
                    error: { message: `创建 auth 目录失败: ${e.message}` },
                });
            }

            let indexToWrite = null;
            if (targetIndex !== undefined && targetIndex !== null) {
                const parsedIndex = parseInt(targetIndex, 10);
                if (Number.isNaN(parsedIndex) || parsedIndex <= 0) {
                    return res.status(400).json({
                        error: { message: "targetIndex 必须是正整数。" },
                    });
                }
                indexToWrite = parsedIndex;
            } else {
                indexToWrite = this.authSource.getNextFileIndex() || 1;
            }

            const authFilePath = path.join(authDir, `auth-${indexToWrite}.json`);
            try {
                fs.writeFileSync(authFilePath, JSON.stringify(parsedState, null, 2));
            } catch (e) {
                return res.status(500).json({
                    error: { message: `写入认证文件失败: ${e.message}` },
                });
            }

            if (this.authSource.authMode !== "file") {
                this.logger.warn(
                    `[Auth] 当前为环境变量模式，已写入文件 ${path.basename(authFilePath)}，但不会自动生效。`
                );
            } else {
                this.authSource.refresh();
            }

            this.logger.info(`[Auth] 已上传并写入认证文件: auth-${indexToWrite}.json`);

            return res.status(200).json({
                success: true,
                index: indexToWrite,
                file: authFilePath,
                mode: this.authSource.authMode,
            });
        });
    }

    _sendStatusPage(req, res) {
        // 状态页面的 HTML 将单独加载
        const statusPageHtml = require("./status-page")(this);
        res.status(200).send(statusPageHtml);
    }

    async _startWebSocketServer() {
        this.wsServer = new WebSocket.Server({
            port: this.config.wsPort,
            host: this.config.host,
        });
        this.wsServer.on("connection", (ws, req) => {
            this.connectionRegistry.addConnection(ws, {
                address: req.socket.remoteAddress,
            });
        });
    }
}

module.exports = { ProxyServerSystem };
