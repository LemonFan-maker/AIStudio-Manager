/**
 * 请求处理器模块
 * 处理 API 请求的转发、翻译和响应
 */

const fs = require("fs");
const path = require("path");

// 获取项目根目录
const ROOT_DIR = path.join(__dirname, "..");

class RequestHandler {
    constructor(
        serverSystem,
        connectionRegistry,
        logger,
        browserManager,
        config,
        authSource
    ) {
        this.serverSystem = serverSystem;
        this.connectionRegistry = connectionRegistry;
        this.logger = logger;
        this.browserManager = browserManager;
        this.config = config;
        this.authSource = authSource;
        this.maxRetries = this.config.maxRetries;
        this.retryDelay = this.config.retryDelay;
        this.failureCount = 0;
        this.usageCount = 0;
        this.isAuthSwitching = false;
        this.needsSwitchingAfterRequest = false;
        this.isSystemBusy = false;
        this.concurrentLimit =
            typeof this.config.maxConcurrentRequests === "number"
                ? this.config.maxConcurrentRequests
                : 0;
        this.activeRequests = 0;
        this.pendingRequests = [];

        // 初始化流量日志记录
        this.trafficLogs = [];
        this.maxTrafficLogs = 1000;
        this.trafficLogFile = path.join(ROOT_DIR, "traffic.json");
        this.logger.info(`[Traffic] 流量日志存储路径: ${this.trafficLogFile}`);
        this._loadTrafficLogs();
    }

    _loadTrafficLogs() {
        try {
            if (fs.existsSync(this.trafficLogFile)) {
                const data = fs.readFileSync(this.trafficLogFile, "utf-8");
                this.trafficLogs = JSON.parse(data);
                this.logger.info(`[Traffic] 已加载 ${this.trafficLogs.length} 条历史流量日志。`);
            }
        } catch (error) {
            this.logger.warn(`[Traffic] 加载流量日志失败: ${error.message}`);
            this.trafficLogs = [];
        }
    }

    _saveTrafficLogs() {
        try {
            const data = JSON.stringify(this.trafficLogs, null, 2);
            fs.writeFileSync(this.trafficLogFile, data, "utf-8");
        } catch (error) {
            this.logger.warn(`[Traffic] 保存流量日志失败: ${error.message}`);
        }
    }

    get currentAuthIndex() {
        return this.browserManager.currentAuthIndex;
    }

    _getMaxAuthIndex() {
        return this.authSource.getMaxIndex();
    }

    _getNextAuthIndex() {
        const available = this.authSource.availableIndices;
        if (available.length === 0) return null;
        const currentIndexInArray = available.indexOf(this.currentAuthIndex);
        if (currentIndexInArray === -1) {
            this.logger.warn(
                `[Auth] 当前索引 ${this.currentAuthIndex} 不在可用列表中，将切换到第一个可用索引。`
            );
            return available[0];
        }
        const nextIndexInArray = (currentIndexInArray + 1) % available.length;
        return available[nextIndexInArray];
    }

    _schedulePendingRequests() {
        if (this.concurrentLimit <= 0) return;
        while (
            this.activeRequests < this.concurrentLimit &&
            this.pendingRequests.length > 0
        ) {
            const nextItem = this.pendingRequests.shift();
            if (!nextItem || nextItem.cancelled) {
                continue;
            }
            nextItem.started = true;
            nextItem.run();
        }
    }

    _runWithConcurrency(requestId, runner) {
        if (this.concurrentLimit <= 0) {
            return { promise: runner(), cancel: null };
        }

        let cancelHandle = null;
        const promise = new Promise((resolve, reject) => {
            const item = {
                id: requestId,
                started: false,
                cancelled: false,
                run: async () => {
                    this.activeRequests++;
                    this.logger.info(
                        `[Queue] 开始处理请求 #${requestId} (并发 ${this.activeRequests}/${this.concurrentLimit})`
                    );
                    try {
                        const result = await runner();
                        resolve(result);
                    } catch (error) {
                        reject(error);
                    } finally {
                        this.activeRequests = Math.max(0, this.activeRequests - 1);
                        this._schedulePendingRequests();
                    }
                },
            };

            if (this.activeRequests < this.concurrentLimit) {
                item.started = true;
                item.run();
            } else {
                this.pendingRequests.push(item);
                this.logger.info(
                    `[Queue] 请求 #${requestId} 已进入队列，等待中: ${this.pendingRequests.length}`
                );
            }

            item.cancel = () => {
                item.cancelled = true;
                if (!item.started) {
                    const index = this.pendingRequests.indexOf(item);
                    if (index !== -1) this.pendingRequests.splice(index, 1);
                    this.logger.info(
                        `[Queue] 请求 #${requestId} 已在排队阶段取消。`
                    );
                }
            };
            cancelHandle = item.cancel;
        });

        return { promise, cancel: cancelHandle };
    }

    async _switchToNextAuth() {
        const available = this.authSource.availableIndices;
        if (available.length === 0) {
            throw new Error("没有可用的认证源，无法切换。");
        }
        if (this.isAuthSwitching) {
            this.logger.info("[Auth] 正在切换/重启账号，跳过重复操作");
            return { success: false, reason: "Switch already in progress." };
        }
        this.isSystemBusy = true;
        this.isAuthSwitching = true;

        try {
            if (available.length === 1) {
                const singleIndex = available[0];
                this.logger.info("==================================================");
                this.logger.info(`[Auth] 单账号模式：达到轮换阈值，正在执行原地重启...`);
                this.logger.info(`   • 目标账号: #${singleIndex}`);
                this.logger.info("==================================================");
                try {
                    await this.browserManager.launchOrSwitchContext(singleIndex);
                    this.failureCount = 0;
                    this.usageCount = 0;
                    this.logger.info(`[Auth] 单账号 #${singleIndex} 重启/刷新成功，使用计数已清零。`);
                    return { success: true, newIndex: singleIndex };
                } catch (error) {
                    this.logger.error(`[Auth] 单账号重启失败: ${error.message}`);
                    throw error;
                }
            }

            const previousAuthIndex = this.currentAuthIndex;
            const nextAuthIndex = this._getNextAuthIndex();
            this.logger.info("==================================================");
            this.logger.info(`[Auth] 多账号模式：开始账号切换流程`);
            this.logger.info(`当前账号: #${previousAuthIndex}`);
            this.logger.info(`目标账号: #${nextAuthIndex}`);
            this.logger.info("==================================================");

            try {
                await this.browserManager.switchAccount(nextAuthIndex);
                this.failureCount = 0;
                this.usageCount = 0;
                this.logger.info(`[Auth] 成功切换到账号 #${this.currentAuthIndex}，计数已重置。`);
                return { success: true, newIndex: this.currentAuthIndex };
            } catch (error) {
                this.logger.error(`[Auth] 切换到账号 #${nextAuthIndex} 失败: ${error.message}`);
                this.logger.warn(`[Auth] 切换失败，正在尝试回退到上一个可用账号 #${previousAuthIndex}...`);
                try {
                    await this.browserManager.launchOrSwitchContext(previousAuthIndex);
                    this.logger.info(`[Auth] 成功回退到账号 #${previousAuthIndex}！`);
                    this.failureCount = 0;
                    this.usageCount = 0;
                    return { success: false, fallback: true, newIndex: this.currentAuthIndex };
                } catch (fallbackError) {
                    this.logger.error(`[Auth] FATAL: 紧急回退也失败！`);
                    throw fallbackError;
                }
            }
        } finally {
            this.isAuthSwitching = false;
            this.isSystemBusy = false;
        }
    }

    async _switchToSpecificAuth(targetIndex) {
        if (this.isAuthSwitching) {
            return { success: false, reason: "Switch already in progress." };
        }
        if (!this.authSource.availableIndices.includes(targetIndex)) {
            return { success: false, reason: `切换失败：账号 #${targetIndex} 无效或不存在。` };
        }
        this.isSystemBusy = true;
        this.isAuthSwitching = true;
        try {
            this.logger.info(`[Auth] 开始切换到指定账号 #${targetIndex}...`);
            await this.browserManager.switchAccount(targetIndex);
            this.failureCount = 0;
            this.usageCount = 0;
            this.logger.info(`[Auth] 成功切换到账号 #${this.currentAuthIndex}，计数已重置。`);
            return { success: true, newIndex: this.currentAuthIndex };
        } catch (error) {
            this.logger.error(`[Auth] 切换到指定账号 #${targetIndex} 失败: ${error.message}`);
            throw error;
        } finally {
            this.isAuthSwitching = false;
            this.isSystemBusy = false;
        }
    }

    async _handleRequestFailureAndSwitch(errorDetails, res) {
        if (this.config.failureThreshold > 0) {
            this.failureCount++;
            this.logger.warn(
                `[Auth] 请求失败 - 失败计数: ${this.failureCount}/${this.config.failureThreshold}`
            );
        }
        const isImmediateSwitch = this.config.immediateSwitchStatusCodes.includes(errorDetails.status);
        const isThresholdReached = this.config.failureThreshold > 0 && this.failureCount >= this.config.failureThreshold;

        if (isImmediateSwitch || isThresholdReached) {
            try {
                await this._switchToNextAuth();
                const successMessage = `目标账户无效，已自动回退至账号 #${this.currentAuthIndex}。`;
                this.logger.info(`[Auth] ${successMessage}`);
                if (res) this._sendErrorChunkToClient(res, successMessage);
            } catch (error) {
                let userMessage = `致命错误：发生未知切换错误: ${error.message}`;
                this.logger.error(`[Auth] 后台账号切换任务最终失败: ${error.message}`);
                if (res) this._sendErrorChunkToClient(res, userMessage);
            }
            return;
        }
    }

    _generateRequestId() {
        return `${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
    }

    _forwardRequest(proxyRequest) {
        const connection = this.connectionRegistry.getFirstConnection();
        if (connection) {
            connection.send(JSON.stringify(proxyRequest));
        } else {
            throw new Error("无法转发请求：没有可用的WebSocket连接。");
        }
    }

    _cancelBrowserRequest(requestId) {
        const connection = this.connectionRegistry.getFirstConnection();
        if (connection) {
            this.logger.info(`[Request] 正在向浏览器发送取消请求 #${requestId} 的指令...`);
            connection.send(JSON.stringify({ event_type: "cancel_request", request_id: requestId }));
        }
    }

    _sendErrorChunkToClient(res, errorMessage) {
        const errorPayload = {
            error: { message: `[代理系统提示] ${errorMessage}`, type: "proxy_error", code: "proxy_error" },
        };
        const chunk = `data: ${JSON.stringify(errorPayload)}\n\n`;
        if (res && !res.writableEnded) {
            res.write(chunk);
            this.logger.info(`[Request] 已向客户端发送标准错误信号: ${errorMessage}`);
        }
    }

    _sendErrorResponse(res, status, message) {
        if (!res.headersSent) {
            const errorPayload = {
                error: { code: status || 500, message: message, status: "SERVICE_UNAVAILABLE" },
            };
            res.status(status || 500).type("application/json").send(JSON.stringify(errorPayload));
        }
    }

    _handleRequestError(error, res) {
        if (res.headersSent) {
            this.logger.error(`[Request] 请求处理错误 (头已发送): ${error.message}`);
            if (this.serverSystem.streamingMode === "fake")
                this._sendErrorChunkToClient(res, `处理失败: ${error.message}`);
            if (!res.writableEnded) res.end();
        } else {
            this.logger.error(`[Request] 请求处理错误: ${error.message}`);
            const status = error.message.includes("超时") ? 504 : 500;
            this._sendErrorResponse(res, status, `代理错误: ${error.message}`);
        }
    }

    _setResponseHeaders(res, headerMessage) {
        res.status(headerMessage.status || 200);
        const headers = headerMessage.headers || {};
        Object.entries(headers).forEach(([name, value]) => {
            if (name.toLowerCase() !== "content-length") res.set(name, value);
        });
    }

    getTrafficStats() {
        const stats = {
            totalRequests: this.trafficLogs.length,
            successRequests: this.trafficLogs.filter((log) => log.status >= 200 && log.status < 300).length,
            errorRequests: this.trafficLogs.filter((log) => log.status >= 400).length,
            totalTokens: this.trafficLogs.reduce((sum, log) => sum + log.tokens, 0),
            avgDuration: this.trafficLogs.length > 0
                ? Math.round(this.trafficLogs.reduce((sum, log) => sum + log.duration, 0) / this.trafficLogs.length)
                : 0,
        };
        return { logs: this.trafficLogs.slice(-100).reverse(), stats: stats };
    }

    _logTrafficRequest(req, status, duration, tokens = 0, responseBody = null) {
        try {
            let model = "unknown";
            const pathMatch = req.path.match(/models\/([^/:]+)/);
            if (pathMatch) model = pathMatch[1];
            else if (req.body && req.body.model) model = req.body.model;

            let protocol = "Google";
            if (req.path.includes("/chat/completions") || req.path.includes("/v1/")) protocol = "OpenAI";

            let inputTokens = 0, outputTokens = 0;
            if (responseBody && tokens === 0) {
                try {
                    const parsed = typeof responseBody === 'string' ? JSON.parse(responseBody) : responseBody;
                    if (parsed.usageMetadata) {
                        inputTokens = parsed.usageMetadata.promptTokenCount || 0;
                        outputTokens = parsed.usageMetadata.candidatesTokenCount || 0;
                        tokens = inputTokens + outputTokens;
                    } else if (parsed.usage) {
                        inputTokens = parsed.usage.prompt_tokens || 0;
                        outputTokens = parsed.usage.completion_tokens || 0;
                        tokens = parsed.usage.total_tokens || (inputTokens + outputTokens);
                    }
                } catch (e) { }
            }

            const log = {
                id: this._generateRequestId(),
                timestamp: new Date().toISOString(),
                method: req.method,
                path: req.path,
                model, protocol,
                account: this.currentAuthIndex,
                status,
                statusText: status >= 200 && status < 300 ? "成功" : "失败",
                tokens, inputTokens, outputTokens, duration,
                requestBody: req.body ? JSON.stringify(req.body) : null,
                responseBody: responseBody ? (typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody)) : null,
            };

            this.trafficLogs.push(log);
            if (this.trafficLogs.length > this.maxTrafficLogs) {
                this.trafficLogs = this.trafficLogs.slice(-this.maxTrafficLogs);
            }
            this._saveTrafficLogs();
        } catch (error) {
            this.logger.warn(`[Traffic] 记录流量日志失败: ${error.message}`);
        }
    }

    // 导入翻译器和处理方法 (将在单独文件中实现较长的方法)
    // processRequest, processOpenAIRequest, _translateOpenAIToGoogle, _translateGoogleToOpenAIStream 等
}

// 加载处理方法的混入
require("./request-handler-methods")(RequestHandler);
require("./request-handler-translators")(RequestHandler);

module.exports = { RequestHandler };
