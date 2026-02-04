const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

/**
 * 从 config.yml 加载配置
 * @param {Object} logger - 日志记录器
 * @returns {Object} 配置对象
 */
function loadConfiguration(logger) {
  let config = {
    httpPort: 7860,
    host: "0.0.0.0",
    wsPort: 9998,
    streamingMode: "real",
    failureThreshold: 3,
    switchOnUses: 40,
    maxRetries: 1,
    retryDelay: 2000,
    maxConcurrentRequests: 3,
    browserExecutablePath: null,
    apiKeys: [],
    immediateSwitchStatusCodes: [429, 503],
    apiKeySource: "未设置",
    initialAuthIndex: 1,
    forceThinking: false,
    forceWebSearch: false,
    forceUrlContext: false,
  };

  const configYmlPath = path.join(__dirname, "config.yml");
  try {
    if (fs.existsSync(configYmlPath)) {
      logger.info("[System] 正在从 config.yml 加载配置...");
      const yamlContent = fs.readFileSync(configYmlPath, "utf-8");
      const yamlConfig = yaml.load(yamlContent);
      
      if (yamlConfig.server) {
        if (yamlConfig.server.httpPort !== undefined) config.httpPort = yamlConfig.server.httpPort;
        if (yamlConfig.server.host) config.host = yamlConfig.server.host;
        if (yamlConfig.server.wsPort !== undefined) config.wsPort = yamlConfig.server.wsPort;
      }
      
      if (yamlConfig.streaming?.mode) {
        config.streamingMode = yamlConfig.streaming.mode;
      }
      
      if (yamlConfig.features) {
        if (yamlConfig.features.forceThinking !== undefined) config.forceThinking = yamlConfig.features.forceThinking;
        if (yamlConfig.features.forceWebSearch !== undefined) config.forceWebSearch = yamlConfig.features.forceWebSearch;
        if (yamlConfig.features.forceUrlContext !== undefined) config.forceUrlContext = yamlConfig.features.forceUrlContext;
      }
      
      if (yamlConfig.accountSwitching) {
        if (yamlConfig.accountSwitching.failureThreshold !== undefined) {
          config.failureThreshold = yamlConfig.accountSwitching.failureThreshold;
        }
        if (yamlConfig.accountSwitching.switchOnUses !== undefined) {
          config.switchOnUses = yamlConfig.accountSwitching.switchOnUses;
        }
        if (Array.isArray(yamlConfig.accountSwitching.immediateSwitchStatusCodes)) {
          config.immediateSwitchStatusCodes = yamlConfig.accountSwitching.immediateSwitchStatusCodes;
        }
      }
      
      if (yamlConfig.retry) {
        if (yamlConfig.retry.maxRetries !== undefined) config.maxRetries = yamlConfig.retry.maxRetries;
        if (yamlConfig.retry.retryDelay !== undefined) config.retryDelay = yamlConfig.retry.retryDelay;
      }
      
      if (yamlConfig.concurrency?.maxConcurrentRequests !== undefined) {
        config.maxConcurrentRequests = yamlConfig.concurrency.maxConcurrentRequests;
      }
      
      if (yamlConfig.browser) {
        if (yamlConfig.browser.executablePath) config.browserExecutablePath = yamlConfig.browser.executablePath;
        if (yamlConfig.browser.initialAuthIndex !== undefined) config.initialAuthIndex = yamlConfig.browser.initialAuthIndex;
      }
      
      if (Array.isArray(yamlConfig.apiKeys) && yamlConfig.apiKeys.length > 0) {
        config.apiKeys = yamlConfig.apiKeys.map((k) => String(k).trim()).filter((k) => k);
      }
      
      logger.info("[System] 已从 config.yml 成功加载配置。");
    } else {
      logger.warn("[System] 未找到 config.yml，将使用默认配置和环境变量。");
    }
  } catch (error) {
    logger.error(`[System] 读取或解析 config.yml 失败: ${error.message}`);
    logger.warn("[System] 将继续使用默认配置和环境变量。");
  }

  const configPath = path.join(__dirname, "config.json");
  try {
    if (fs.existsSync(configPath)) {
      const fileConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
      config = { ...config, ...fileConfig };
      logger.info("[System] 已从 config.json 加载配置（兼容模式）。");
    }
  } catch (error) {
    logger.warn(`[System] 无法读取或解析 config.json: ${error.message}`);
  }

  if (process.env.PORT)
    config.httpPort = parseInt(process.env.PORT, 10) || config.httpPort;
  if (process.env.HOST) config.host = process.env.HOST;
  if (process.env.STREAMING_MODE)
    config.streamingMode = process.env.STREAMING_MODE;
  if (process.env.FAILURE_THRESHOLD)
    config.failureThreshold =
      parseInt(process.env.FAILURE_THRESHOLD, 10) || config.failureThreshold;
  if (process.env.SWITCH_ON_USES)
    config.switchOnUses =
      parseInt(process.env.SWITCH_ON_USES, 10) || config.switchOnUses;
  if (process.env.MAX_RETRIES)
    config.maxRetries =
      parseInt(process.env.MAX_RETRIES, 10) || config.maxRetries;
  if (process.env.RETRY_DELAY)
    config.retryDelay =
      parseInt(process.env.RETRY_DELAY, 10) || config.retryDelay;
  if (process.env.MAX_CONCURRENT_REQUESTS)
    config.maxConcurrentRequests =
      parseInt(process.env.MAX_CONCURRENT_REQUESTS, 10) ||
      config.maxConcurrentRequests;
  if (process.env.CAMOUFOX_EXECUTABLE_PATH)
    config.browserExecutablePath = process.env.CAMOUFOX_EXECUTABLE_PATH;
  if (process.env.API_KEYS) {
    config.apiKeys = process.env.API_KEYS.split(",");
  }
  if (process.env.INITIAL_AUTH_INDEX) {
    config.initialAuthIndex = parseInt(process.env.INITIAL_AUTH_INDEX, 10) || config.initialAuthIndex;
  }
  if (process.env.FORCE_THINKING !== undefined) {
    config.forceThinking = process.env.FORCE_THINKING === "true";
  }
  if (process.env.FORCE_WEB_SEARCH !== undefined) {
    config.forceWebSearch = process.env.FORCE_WEB_SEARCH === "true";
  }
  if (process.env.FORCE_URL_CONTEXT !== undefined) {
    config.forceUrlContext = process.env.FORCE_URL_CONTEXT === "true";
  }

  let rawCodes = process.env.IMMEDIATE_SWITCH_STATUS_CODES;
  let codesSource = "环境变量";

  if (
    !rawCodes &&
    config.immediateSwitchStatusCodes &&
    Array.isArray(config.immediateSwitchStatusCodes)
  ) {
    rawCodes = config.immediateSwitchStatusCodes.join(",");
    codesSource = "配置文件或默认值";
  }

  if (rawCodes && typeof rawCodes === "string") {
    config.immediateSwitchStatusCodes = rawCodes
      .split(",")
      .map((code) => parseInt(String(code).trim(), 10))
      .filter((code) => !isNaN(code) && code >= 400 && code <= 599);
    if (config.immediateSwitchStatusCodes.length > 0) {
      logger.info(`[System] 已从 ${codesSource} 加载"立即切换报错码"。`);
    }
  } else {
    config.immediateSwitchStatusCodes = [];
  }

  if (Array.isArray(config.apiKeys)) {
    config.apiKeys = config.apiKeys
      .map((k) => String(k).trim())
      .filter((k) => k);
  } else {
    config.apiKeys = [];
  }

  if (config.apiKeys.length > 0) {
    if (config.apiKeys.length === 1 && config.apiKeys[0] === "your-secret-api-key-here") {
      logger.warn("[System] 检测到模板 API Key，这将被视为未配置！");
      config.apiKeys = []; // 视为空，允许初始化
      config.apiKeySource = "未配置";
    } else {
      config.apiKeySource = "自定义";
    }
  } else {
    config.apiKeys = [];
    config.apiKeySource = "未设置";
    logger.warn("[System] 未设置任何API Key，等待首次初始化或使用空密码访问");
  }

  const modelsPath = path.join(__dirname, "models.json");
  try {
    if (fs.existsSync(modelsPath)) {
      const modelsFileContent = fs.readFileSync(modelsPath, "utf-8");
      config.modelList = JSON.parse(modelsFileContent);
      logger.info(
        `[System] 已从 models.json 成功加载 ${config.modelList.length} 个模型。`
      );
    } else {
      logger.warn(
        `[System] 未找到 models.json 文件，将使用默认模型列表。`
      );
      config.modelList = ["gemini-1.5-pro-latest"];
    }
  } catch (error) {
    logger.error(
      `[System] 读取或解析 models.json 失败: ${error.message}，将使用默认模型列表。`
    );
    config.modelList = ["gemini-1.5-pro-latest"];
  }

  logger.info("================ [ 生效配置 ] ================");
  logger.info(`配置来源: config.yml ${fs.existsSync(configYmlPath) ? '✓' : '✗'}`);
  logger.info(`HTTP 服务端口: ${config.httpPort}`);
  logger.info(`监听地址: ${config.host}`);
  logger.info(`流式模式: ${config.streamingMode}`);
  logger.info(`强制思维推理: ${config.forceThinking ? '已启用' : '已关闭'}`);
  logger.info(`强制联网搜索: ${config.forceWebSearch ? '已启用' : '已关闭'}`);
  logger.info(`强制URL上下文: ${config.forceUrlContext ? '已启用' : '已关闭'}`);
  logger.info(
    `轮换计数切换阈值: ${
      config.switchOnUses > 0
        ? `每 ${config.switchOnUses} 次请求后切换`
        : "已禁用"
    }`
  );
  logger.info(
    `失败计数切换: ${
      config.failureThreshold > 0
        ? `失败${config.failureThreshold} 次后切换`
        : "已禁用"
    }`
  );
  logger.info(
    `立即切换报错码: ${
      config.immediateSwitchStatusCodes.length > 0
        ? config.immediateSwitchStatusCodes.join(", ")
        : "已禁用"
    }`
  );
  logger.info(`单次请求最大重试: ${config.maxRetries}次`);
  logger.info(`重试间隔: ${config.retryDelay}ms`);
  logger.info(`最大并发请求: ${config.maxConcurrentRequests}`);
  logger.info(`API 密钥来源: ${config.apiKeySource}`);
  logger.info(`初始认证索引: ${config.initialAuthIndex}`);
  logger.info(
    "============================================================="
  );

  return config;
}

module.exports = { loadConfiguration };
