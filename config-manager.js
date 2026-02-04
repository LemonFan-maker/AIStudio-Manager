// 配置管理模块 - 用于读取和保存配置
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

/**
 * 读取当前配置
 */
function readConfig() {
  const configYmlPath = path.join(__dirname, "config.yml");
  
  if (!fs.existsSync(configYmlPath)) {
    return null;
  }
  
  try {
    const yamlContent = fs.readFileSync(configYmlPath, "utf-8");
    return yaml.load(yamlContent);
  } catch (error) {
    throw new Error(`读取配置文件失败: ${error.message}`);
  }
}

/**
 * 保存配置到 config.yml
 */
function saveConfig(config) {
  const configYmlPath = path.join(__dirname, "config.yml");
  
  try {
    const yamlContent = yaml.dump(config, {
      indent: 2,
      lineWidth: 120,
      noRefs: true,
    });
    
    fs.writeFileSync(configYmlPath, yamlContent, "utf-8");
    return true;
  } catch (error) {
    throw new Error(`保存配置文件失败: ${error.message}`);
  }
}

/**
 * 更新配置中的某个值
 */
function updateConfigValue(path, value) {
  const config = readConfig();
  
  if (!config) {
    throw new Error("配置文件不存在");
  }
  
  // 使用点号分隔的路径来设置嵌套值
  const keys = path.split(".");
  let current = config;
  
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (!current[key]) {
      current[key] = {};
    }
    current = current[key];
  }
  
  const lastKey = keys[keys.length - 1];
  current[lastKey] = value;
  
  saveConfig(config);
  return config;
}

module.exports = {
  readConfig,
  saveConfig,
  updateConfigValue,
};
