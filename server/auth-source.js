/**
 * 认证源管理模块
 * 管理从文件或环境变量加载的认证凭据
 */

const fs = require("fs");
const path = require("path");

// 获取项目根目录
const ROOT_DIR = path.join(__dirname, "..");

class AuthSource {
    constructor(logger) {
        this.logger = logger;
        this.authMode = "file";
        this.availableIndices = [];
        this.initialIndices = [];
        this.accountNameMap = new Map();

        if (process.env.AUTH_JSON_1) {
            this.authMode = "env";
            this.logger.info(
                "[Auth] 检测到 AUTH_JSON_1 环境变量，切换到环境变量认证模式。"
            );
        } else {
            this.logger.info(
                '[Auth] 未检测到环境变量认证，将使用 "auth/" 目录下的文件。'
            );
        }

        this._discoverAvailableIndices(); // 初步发现所有存在的源
        this._preValidateAndFilter(); // 预检验并过滤掉格式错误的源

        if (this.availableIndices.length === 0) {
            this.logger.warn(
                `[Auth] 在 '${this.authMode}' 模式下未找到任何有效的认证源。服务器将以"空转"模式启动。`
            );
        }
    }

    refresh() {
        this._discoverAvailableIndices();
        this._preValidateAndFilter();
    }

    getNextFileIndex() {
        if (this.authMode !== "file") {
            return null;
        }
        if (!this.initialIndices || this.initialIndices.length === 0) return 1;
        return Math.max(...this.initialIndices) + 1;
    }

    _discoverAvailableIndices() {
        let indices = [];
        if (this.authMode === "env") {
            const regex = /^AUTH_JSON_(\d+)$/;
            for (const key in process.env) {
                const match = key.match(regex);
                if (match && match[1]) {
                    indices.push(parseInt(match[1], 10));
                }
            }
        } else {
            // 'file' mode
            const authDir = path.join(ROOT_DIR, "auth");
            if (!fs.existsSync(authDir)) {
                this.logger.warn('[Auth] "auth/" 目录不存在。');
                this.availableIndices = [];
                return;
            }
            try {
                const files = fs.readdirSync(authDir);
                const authFiles = files.filter((file) => /^auth-\d+\.json$/.test(file));
                indices = authFiles.map((file) =>
                    parseInt(file.match(/^auth-(\d+)\.json$/)[1], 10)
                );
            } catch (error) {
                this.logger.error(`[Auth] 扫描 "auth/" 目录失败: ${error.message}`);
                this.availableIndices = [];
                return;
            }
        }

        // 存取扫描到的原始索引
        this.initialIndices = [...new Set(indices)].sort((a, b) => a - b);
        this.availableIndices = [...this.initialIndices]; // 先假设都可用

        this.logger.info(
            `[Auth] 在 '${this.authMode}' 模式下，初步发现 ${this.initialIndices.length
            } 个认证源: [${this.initialIndices.join(", ")}]`
        );
    }

    _preValidateAndFilter() {
        if (this.availableIndices.length === 0) return;

        this.logger.info("[Auth] 开始预检验所有认证源的JSON格式...");
        const validIndices = [];
        const invalidSourceDescriptions = [];

        for (const index of this.availableIndices) {
            // 注意：这里我们调用一个内部的、简化的 getAuthContent
            const authContent = this._getAuthContent(index);
            if (authContent) {
                try {
                    const authData = JSON.parse(authContent);
                    validIndices.push(index);
                    this.accountNameMap.set(
                        index,
                        authData.accountName || "N/A (未命名)"
                    );
                } catch (e) {
                    invalidSourceDescriptions.push(`auth-${index}`);
                }
            } else {
                invalidSourceDescriptions.push(`auth-${index} (无法读取)`);
            }
        }

        if (invalidSourceDescriptions.length > 0) {
            this.logger.warn(
                `[Auth] 预检验发现 ${invalidSourceDescriptions.length
                } 个格式错误或无法读取的认证源: [${invalidSourceDescriptions.join(
                    ", "
                )}]，将从可用列表中移除。`
            );
        }

        this.availableIndices = validIndices;
    }

    // 一个内部辅助函数，仅用于预检验，避免日志污染
    _getAuthContent(index) {
        if (this.authMode === "env") {
            return process.env[`AUTH_JSON_${index}`];
        } else {
            const authFilePath = path.join(ROOT_DIR, "auth", `auth-${index}.json`);
            if (!fs.existsSync(authFilePath)) return null;
            try {
                return fs.readFileSync(authFilePath, "utf-8");
            } catch (e) {
                return null;
            }
        }
    }

    getAuth(index) {
        if (!this.availableIndices.includes(index)) {
            this.logger.error(`[Auth] 请求了无效或不存在的认证索引: ${index}`);
            return null;
        }

        let jsonString = this._getAuthContent(index);
        if (!jsonString) {
            this.logger.error(`[Auth] 在读取时无法获取认证源 #${index} 的内容。`);
            return null;
        }

        try {
            return JSON.parse(jsonString);
        } catch (e) {
            this.logger.error(
                `[Auth] 解析来自认证源 #${index} 的JSON内容失败: ${e.message}`
            );
            return null;
        }
    }
}

module.exports = { AuthSource, ROOT_DIR };
