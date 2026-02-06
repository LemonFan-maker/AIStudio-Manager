/**
 * AIStudio2API 代理服务器
 * 
 * 这是服务器的主入口文件。
 * 所有核心功能都已模块化到 server/ 目录下。
 * 
 * 模块结构:
 * - server/logging-service.js    - 日志服务
 * - server/message-queue.js      - 消息队列
 * - server/auth-source.js        - 认证源管理
 * - server/browser-manager.js    - 浏览器管理
 * - server/connection-registry.js - 连接注册表
 * - server/request-handler.js    - 请求处理器
 * - server/proxy-server-system.js - 代理服务器系统
 * - server/status-page.js        - 状态页面
 * - server/index.js              - 模块入口
 */

const { ProxyServerSystem } = require("./server/proxy-server-system");
const { BrowserManager } = require("./server/browser-manager");

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

// 如果直接运行此文件，则启动服务器
if (require.main === module) {
  initializeServer();
}

// 保持向后兼容性的导出
module.exports = { ProxyServerSystem, BrowserManager, initializeServer };
