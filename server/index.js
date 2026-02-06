/**
 * 服务器模块入口
 * 统一导出所有服务器组件
 * 
 * 注意：此文件主要用于从 server/ 目录导入模块时使用。
 * 如果是作为主入口运行，请使用根目录下的 server.js。
 */

const { LoggingService } = require("./logging-service");
const { MessageQueue } = require("./message-queue");
const { AuthSource, ROOT_DIR } = require("./auth-source");
const { BrowserManager } = require("./browser-manager");
const { ConnectionRegistry } = require("./connection-registry");
const { RequestHandler } = require("./request-handler");
const { ProxyServerSystem } = require("./proxy-server-system");

/**
 * 初始化并启动服务器
 */
async function initializeServer() {
    try {
        const serverSystem = new ProxyServerSystem();
        // 使用配置文件中的 initialAuthIndex，可被环境变量覆盖
        const initialAuthIndex = process.env.INITIAL_AUTH_INDEX
            ? parseInt(process.env.INITIAL_AUTH_INDEX, 10)
            : serverSystem.config.initialAuthIndex;
        await serverSystem.start(initialAuthIndex);
    } catch (error) {
        console.error("服务器启动失败:", error.message);
        process.exit(1);
    }
}

// 导出所有模块和函数
module.exports = {
    // 服务组件
    LoggingService,
    MessageQueue,
    AuthSource,
    BrowserManager,
    ConnectionRegistry,
    RequestHandler,
    ProxyServerSystem,

    // 入口函数
    initializeServer,

    // 常量
    ROOT_DIR,
};
