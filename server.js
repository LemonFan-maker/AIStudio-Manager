const session = require("express-session");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");
const express = require("express");
const WebSocket = require("ws");
const http = require("http");
const { EventEmitter } = require("events");
const fs = require("fs");
const path = require("path");
const { firefox } = require("playwright");
const os = require("os");
const { loadConfiguration } = require("./config-loader");
const { readConfig, saveConfig } = require("./config-manager");

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
        `[Auth] 在 '${this.authMode}' 模式下未找到任何有效的认证源。服务器将以“空转”模式启动。`
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
      const authDir = path.join(__dirname, "auth");
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
      `[Auth] 在 '${this.authMode}' 模式下，初步发现 ${
        this.initialIndices.length
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
        `[Auth] 预检验发现 ${
          invalidSourceDescriptions.length
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
      const authFilePath = path.join(__dirname, "auth", `auth-${index}.json`);
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
// ===================================================================================
// BROWSER MANAGEMENT MODULE
// ===================================================================================

class BrowserManager {
  constructor(logger, config, authSource) {
    this.logger = logger;
    this.config = config;
    this.authSource = authSource;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.currentAuthIndex = 0;
    this.scriptFileName = "black-browser.js";
    this.noButtonCount = 0;
    this.launchArgs = [
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-infobars",
      "--disable-background-networking",
      "--disable-default-apps",
      "--disable-extensions",
      "--disable-sync",
      "--disable-translate",
      "--metrics-recording-only",
      "--mute-audio",
      "--safebrowsing-disable-auto-update",
    ];

    if (this.config.browserExecutablePath) {
      this.browserExecutablePath = this.config.browserExecutablePath;
    } else {
      const platform = os.platform();
      if (platform === "linux") {
        this.browserExecutablePath = path.join(
          __dirname,
          "camoufox",
          "camoufox"
        );
      } else {
        throw new Error(`Unsupported operating system: ${platform}`);
      }
    }
  }

  notifyUserActivity() {
    if (this.noButtonCount > 0) {
      this.logger.info(
        "[Browser] 收到用户请求信号，强制唤醒后台检测 (重置计数器)"
      );
      this.noButtonCount = 0;
    }
  }

  async launchOrSwitchContext(authIndex) {
    if (!this.browser) {
      this.logger.info("[Browser] 浏览器实例未运行，正在进行首次启动...");
      if (!fs.existsSync(this.browserExecutablePath)) {
        throw new Error(
          `Browser executable not found at path: ${this.browserExecutablePath}`
        );
      }
      this.browser = await firefox.launch({
        headless: true,
        executablePath: this.browserExecutablePath,
        args: this.launchArgs,
      });
      this.browser.on("disconnected", () => {
        this.logger.error("[Browser] 浏览器意外断开连接！");
        this.browser = null;
        this.context = null;
        this.page = null;
      });
      this.logger.info("[Browser] 浏览器实例已成功启动。");
    }
    if (this.context) {
      this.logger.info("[Browser] 正在关闭旧的浏览器上下文...");
      await this.context.close();
      this.context = null;
      this.page = null;
      this.logger.info("[Browser] 旧上下文已关闭。");
    }

    const sourceDescription =
      this.authSource.authMode === "env"
        ? `环境变量 AUTH_JSON_${authIndex}`
        : `文件 auth-${authIndex}.json`;
    this.logger.info("==================================================");
    this.logger.info(
      `[Browser] 正在为账号 #${authIndex} 创建新的浏览器上下文`
    );
    this.logger.info(`认证源: ${sourceDescription}`);
    this.logger.info("==================================================");

    const storageStateObject = this.authSource.getAuth(authIndex);
    if (!storageStateObject) {
      throw new Error(
        `Failed to get or parse auth source for index ${authIndex}.`
      );
    }
    const buildScriptContent = fs.readFileSync(
      path.join(__dirname, this.scriptFileName),
      "utf-8"
    );

    try {
      this.context = await this.browser.newContext({
        storageState: storageStateObject,
        viewport: { width: 1920, height: 1080 },
      });
      this.page = await this.context.newPage();
      this.page.on("console", (msg) => {
        const msgText = msg.text();
        if (msgText.includes("[ProxyClient]")) {
          this.logger.info(
            `[Browser] ${msgText.replace("[ProxyClient] ", "")}`
          );
        } else if (msg.type() === "error") {
          this.logger.error(`[Browser Page Error] ${msgText}`);
        }
      });

      this.logger.info(`[Browser] 正在导航至目标网页...`);
      const targetUrl =
        "https://aistudio.google.com/u/0/apps/bundled/blank?showPreview=true&showCode=true&showAssistant=true";
      await this.page.goto(targetUrl, {
        timeout: 180000,
        waitUntil: "domcontentloaded",
      });
      this.logger.info("[Browser] 页面加载完成。");

      await this.page.waitForTimeout(3000);

      const currentUrl = this.page.url();
      let pageTitle = "";
      try {
        pageTitle = await this.page.title();
      } catch (e) {
        this.logger.warn(`[Browser] 无法获取页面标题: ${e.message}`);
      }

      this.logger.info(`[Browser] [诊断] URL: ${currentUrl}`);
      this.logger.info(`[Browser] [诊断] Title: "${pageTitle}"`);

      // 1. 检查 Cookie 是否失效 (跳转回登录页)
      if (
        currentUrl.includes("accounts.google.com") ||
        currentUrl.includes("ServiceLogin") ||
        pageTitle.includes("Sign in") ||
        pageTitle.includes("登录")
      ) {
        throw new Error(
          "Cookie 已失效/过期！浏览器被重定向到了 Google 登录页面。请重新提取 storageState。"
        );
      }

      // 2. 检查 IP 地区限制 (Region Unsupported)
      // 通常标题是 "Google AI Studio is not available in your location"
      if (
        pageTitle.includes("Available regions") ||
        pageTitle.includes("not available")
      ) {
        throw new Error(
          "当前 IP 不支持访问 Google AI Studio。请更换节点后重启！"
        );
      }

      // 3. 检查 IP 风控 (403 Forbidden)
      if (pageTitle.includes("403") || pageTitle.includes("Forbidden")) {
        throw new Error(
          "403 Forbidden：当前 IP 信誉过低，被 Google 风控拒绝访问。"
        );
      }

      // 4. 检查白屏 (网络极差或加载失败)
      if (currentUrl === "about:blank") {
        throw new Error(
          "页面加载失败 (about:blank)，可能是网络连接超时或浏览器崩溃。"
        );
      }

      this.logger.info(
        `[Browser] 进入 5秒 检查流程 (目标: Cookie + Got it + 新手引导)...`
      );

      const startTime = Date.now();
      const timeLimit = 5000;

      // 状态记录表
      const popupStatus = {
        cookie: false,
        gotIt: false,
        guide: false,
      };

      while (Date.now() - startTime < timeLimit) {
        // 如果3个都处理过了，立刻退出 ---
        if (popupStatus.cookie && popupStatus.gotIt && popupStatus.guide) {
          this.logger.info(
            `[Browser] 3个弹窗全部处理完毕，提前进入下一步。`
          );
          break;
        }

        let clickedInThisLoop = false;

        // 1. 检查 Cookie "Agree" (如果还没点过)
        if (!popupStatus.cookie) {
          try {
            const agreeBtn = this.page.locator('button:text("Agree")').first();
            if (await agreeBtn.isVisible({ timeout: 100 })) {
              await agreeBtn.click({ force: true });
              this.logger.info(`[Browser] (1/3) 点击了 "Cookie Agree"`);
              popupStatus.cookie = true;
              clickedInThisLoop = true;
            }
          } catch (e) {}
        }

        // 2. 检查 "Got it" (如果还没点过)
        if (!popupStatus.gotIt) {
          try {
            const gotItBtn = this.page
              .locator('div.dialog button:text("Got it")')
              .first();
            if (await gotItBtn.isVisible({ timeout: 100 })) {
              await gotItBtn.click({ force: true });
              this.logger.info(`[Browser] (2/3) 点击了 "Got it" 弹窗`);
              popupStatus.gotIt = true;
              clickedInThisLoop = true;
            }
          } catch (e) {}
        }

        // 3. 检查 新手引导 "Close" (如果还没点过)
        if (!popupStatus.guide) {
          try {
            const closeBtn = this.page
              .locator('button[aria-label="Close"]')
              .first();
            if (await closeBtn.isVisible({ timeout: 100 })) {
              await closeBtn.click({ force: true });
              this.logger.info(`[Browser] (3/3) 点击了 "新手引导关闭" 按钮`);
              popupStatus.guide = true;
              clickedInThisLoop = true;
            }
          } catch (e) {}
        }

        // 如果本轮点击了按钮，稍微等一下动画；如果没点，等待1秒避免死循环空转
        await this.page.waitForTimeout(clickedInThisLoop ? 500 : 1000);
      }

      this.logger.info(
        `[Browser] 弹窗检查结束 (耗时: ${Math.round(
          (Date.now() - startTime) / 1000
        )}s)，结果: ` +
          `Cookie[${popupStatus.cookie ? "Ok" : "No"}], ` +
          `GotIt[${popupStatus.gotIt ? "Ok" : "No"}], ` +
          `Guide[${popupStatus.guide ? "Ok" : "No"}]`
      );

      this.logger.info(
        `[Browser] 弹窗清理阶段结束，准备进入 Code 按钮点击流程。`
      );

      await this.page.evaluate(() => {
        const overlays = document.querySelectorAll("div.cdk-overlay-backdrop");
        if (overlays.length > 0) {
          console.log(
            `[ProxyClient] (内部JS) 发现并移除了 ${overlays.length} 个遮罩层。`
          );
          overlays.forEach((el) => el.remove());
        }
      });

      this.logger.info('[Browser] (步骤1/5) 准备点击 "Code" 按钮...');
      for (let i = 1; i <= 5; i++) {
        try {
          this.logger.info(`  [尝试 ${i}/5] 清理遮罩层并点击...`);
          await this.page.evaluate(() => {
            document
              .querySelectorAll("div.cdk-overlay-backdrop")
              .forEach((el) => el.remove());
          });
          await this.page.waitForTimeout(500);

          await this.page
            .locator('button:text("Code")')
            .click({ timeout: 10000 });
          this.logger.info("  点击成功！");
          break;
        } catch (error) {
          this.logger.warn(
            `  [尝试 ${i}/5] 点击失败: ${error.message.split("\n")[0]}`
          );
          if (i === 5) {
            // [新增截图] 在最终失败时保存截图
            try {
              const screenshotPath = path.join(
                __dirname,
                "debug_screenshot_final.png"
              );
              await this.page.screenshot({
                path: screenshotPath,
                fullPage: true,
              });
              this.logger.info(
                `[调试] 最终失败截图已保存到: ${screenshotPath}`
              );
            } catch (screenshotError) {
              this.logger.error(
                `[调试] 保存截图失败: ${screenshotError.message}`
              );
            }
            throw new Error(`多次尝试后仍无法点击 "Code" 按钮，初始化失败。`);
          }
        }
      }

      this.logger.info(
        '[Browser] (步骤2/5) "Code" 按钮点击成功，等待编辑器变为可见...'
      );
      const editorContainerLocator = this.page
        .locator("div.monaco-editor")
        .first();
      await editorContainerLocator.waitFor({
        state: "visible",
        timeout: 60000,
      });

      this.logger.info(
        "[Browser] 准备点击编辑器，再次强行移除所有可能的遮罩层..."
      );
      await this.page.evaluate(() => {
        const overlays = document.querySelectorAll("div.cdk-overlay-backdrop");
        if (overlays.length > 0) {
          console.log(
            `[ProxyClient] (内部JS) 发现并移除了 ${overlays.length} 个新出现的遮罩层。`
          );
          overlays.forEach((el) => el.remove());
        }
      });
      await this.page.waitForTimeout(250);

      this.logger.info("[Browser] (步骤3/5) 编辑器已显示，聚焦并粘贴脚本...");
      await editorContainerLocator.click({ timeout: 30000 });

      await this.page.evaluate(
        (text) => navigator.clipboard.writeText(text),
        buildScriptContent
      );
      const isMac = os.platform() === "darwin";
      const pasteKey = isMac ? "Meta+V" : "Control+V";
      await this.page.keyboard.press(pasteKey);
      this.logger.info("[Browser] (步骤4/5) 脚本已粘贴。");
      this.logger.info(
        '[Browser] (步骤5/5) 正在点击 "Preview" 按钮以使脚本生效...'
      );
      await this.page.locator('button:text("Preview")').click();
      this.logger.info("[Browser] UI交互完成，脚本已开始运行。");
      this.currentAuthIndex = authIndex;
      this._startBackgroundWakeup();
      this.logger.info("[Browser] 监控进程已启动...");
      await this.page.waitForTimeout(1000);
      this.logger.info(
        "[Browser] 正在发送主动唤醒请求以触发 Launch 流程..."
      );
      try {
        await this.page.evaluate(async () => {
          try {
            await fetch(
              "https://generativelanguage.googleapis.com/v1beta/models?key=ActiveTrigger",
              {
                method: "GET",
                headers: { "Content-Type": "application/json" },
              }
            );
          } catch (e) {
            console.log(
              "[ProxyClient] 主动唤醒请求已发送 (预期内可能会失败，这很正常)"
            );
          }
        });
        this.logger.info("[Browser] 主动唤醒请求已发送。");
      } catch (e) {
        this.logger.warn(
          `[Browser] 主动唤醒请求发送异常 (不影响主流程): ${e.message}`
        );
      }

      this.logger.info("==================================================");
      this.logger.info(`[Browser] 账号 ${authIndex} 的上下文初始化成功！`);
      this.logger.info("[Browser] 浏览器客户端已准备就绪。");
      this.logger.info("==================================================");
      this._startBackgroundWakeup();
    } catch (error) {
      this.logger.error(
        `[Browser] 账户 ${authIndex} 的上下文初始化失败: ${error.message}`
      );
      if (this.browser) {
        await this.browser.close();
        this.browser = null;
      }
      throw error;
    }
  }

  async closeBrowser() {
    if (this.browser) {
      this.logger.info("[Browser] 正在关闭整个浏览器实例...");
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.page = null;
      this.logger.info("[Browser] 浏览器实例已关闭。");
    }
  }

  async switchAccount(newAuthIndex) {
    this.logger.info(
      `[Browser] 开始账号切换: 从 ${this.currentAuthIndex} 到 ${newAuthIndex}`
    );
    await this.launchOrSwitchContext(newAuthIndex);
    this.logger.info(
      `[Browser] 账号切换完成，当前账号: ${this.currentAuthIndex}`
    );
  }

  async _startBackgroundWakeup() {
    const currentPage = this.page;
    await new Promise((r) => setTimeout(r, 1500));
    if (!currentPage || currentPage.isClosed() || this.page !== currentPage)
      return;
    this.logger.info("[Browser] 网页保活监控已启动");
    while (
      currentPage &&
      !currentPage.isClosed() &&
      this.page === currentPage
    ) {
      try {
        // --- [增强步骤 1] 强制唤醒页面 (解决不发请求不刷新的问题) ---
        await currentPage.bringToFront().catch(() => {});

        // 关键：在无头模式下，仅仅 bringToFront 可能不够，需要伪造鼠标移动来触发渲染帧
        // 随机在一个无害区域轻微晃动鼠标
        await currentPage.mouse.move(10, 10);
        await currentPage.mouse.move(20, 20);

        // --- [增强步骤 2] 智能查找 (查找文本并向上锁定可交互父级) ---
        const targetInfo = await currentPage.evaluate(() => {
          // 1. 直接CSS定位
          try {
            const preciseCandidates = Array.from(
              document.querySelectorAll(
                ".interaction-modal p, .interaction-modal button"
              )
            );
            for (const el of preciseCandidates) {
              const text = (el.innerText || "").trim();
              if (/Launch|rocket_launch/i.test(text)) {
                const rect = el.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                  return {
                    found: true,
                    x: rect.left + rect.width / 2,
                    y: rect.top + rect.height / 2,
                    tagName: el.tagName,
                    text: text.substring(0, 15),
                    strategy: "precise_css", // 标记：这是通过精准CSS找到的
                  };
                }
              }
            }
          } catch (e) {}
          // 2. 扫描Y轴400-800范围刻意元素
          const MIN_Y = 400;
          const MAX_Y = 800;

          // 辅助函数：判断元素是否可见且在区域内
          const isValid = (rect) => {
            return (
              rect.width > 0 &&
              rect.height > 0 &&
              rect.top > MIN_Y &&
              rect.top < MAX_Y
            );
          };

          // 扫描所有包含关键词的元素
          const candidates = Array.from(
            document.querySelectorAll("button, span, div, a, i")
          );

          for (const el of candidates) {
            const text = (el.innerText || "").trim();
            // 匹配 Launch 或 rocket_launch 图标名
            if (!/Launch|rocket_launch/i.test(text)) continue;

            let targetEl = el;
            let rect = targetEl.getBoundingClientRect();

            // [关键优化] 如果当前元素很小或是纯文本容器，尝试向上找 3 层父级
            let parentDepth = 0;
            while (parentDepth < 3 && targetEl.parentElement) {
              if (
                targetEl.tagName === "BUTTON" ||
                targetEl.getAttribute("role") === "button"
              ) {
                break;
              }
              const parent = targetEl.parentElement;
              const pRect = parent.getBoundingClientRect();
              if (isValid(pRect)) {
                targetEl = parent;
                rect = pRect;
              }
              parentDepth++;
            }

            // 最终检查
            if (isValid(rect)) {
              return {
                found: true,
                x: rect.left + rect.width / 2,
                y: rect.top + rect.height / 2,
                tagName: targetEl.tagName,
                text: text.substring(0, 15),
                strategy: "fuzzy_scan", // 标记：这是通过模糊扫描找到的
              };
            }
          }
          return { found: false };
        });

        // --- [增强步骤 3] 执行操作 ---
        if (targetInfo.found) {
          this.noButtonCount = 0;
          this.logger.info(
            `[Browser] 锁定目标 [${targetInfo.tagName}] (策略: ${
              targetInfo.strategy === "precise_css" ? "精准定位" : "模糊扫描"
            })...`
          );

          // === 策略 A: 物理点击 (模拟真实鼠标) ===
          // 1. 移动过去
          await currentPage.mouse.move(targetInfo.x, targetInfo.y, {
            steps: 5,
          });
          // 2. 悬停 (给 hover 样式一点反应时间)
          await new Promise((r) => setTimeout(r, 300));
          // 3. 按下
          await currentPage.mouse.down();
          // 4. 长按 (某些按钮防误触，需要按住一小会儿)
          await new Promise((r) => setTimeout(r, 400));
          // 5. 抬起
          await currentPage.mouse.up();

          this.logger.info(`[Browser] 物理点击已执行，验证结果...`);
          await new Promise((r) => setTimeout(r, 1500));

          const isStillThere = await currentPage.evaluate(() => {
            const allText = document.body.innerText;
            const els = Array.from(
              document.querySelectorAll('button, span, div[role="button"]')
            );
            return els.some((el) => {
              const r = el.getBoundingClientRect();
              return (
                /Launch|rocket_launch/i.test(el.innerText) &&
                r.top > 400 &&
                r.top < 800 &&
                r.height > 0
              );
            });
          });

          if (isStillThere) {
            this.logger.warn(
              `[Browser] 物理点击似乎无效（按钮仍在），尝试 JS 强力点击...`
            );

            await currentPage.evaluate(() => {
              const MIN_Y = 400;
              const MAX_Y = 800;
              const candidates = Array.from(
                document.querySelectorAll('button, span, div[role="button"]')
              );
              for (const el of candidates) {
                const r = el.getBoundingClientRect();
                if (
                  /Launch|rocket_launch/i.test(el.innerText) &&
                  r.top > MIN_Y &&
                  r.top < MAX_Y
                ) {
                  let target = el;
                  if (target.closest("button"))
                    target = target.closest("button");
                  target.click();
                  console.log(
                    "[ProxyClient] JS 点击钩起于: " + target.tagName
                  );
                  return true;
                }
              }
            });
            await new Promise((r) => setTimeout(r, 2000));
          } else {
            this.logger.info(`[Browser] 物理点击成功，按钮已消失。`);
            await new Promise((r) => setTimeout(r, 60000));
            this.noButtonCount = 21;
          }
        } else {
          this.noButtonCount++;
          // 5. [关键] 智能休眠逻辑 (支持被唤醒)
          if (this.noButtonCount > 20) {
            for (let i = 0; i < 30; i++) {
              if (this.noButtonCount === 0) {
                break;
              }
              await new Promise((r) => setTimeout(r, 1000));
            }
          } else {
            await new Promise((r) => setTimeout(r, 1500));
          }
        }
      } catch (e) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }
}

// ===================================================================================
// PROXY SERVER MODULE
// ===================================================================================

class LoggingService {
  constructor(serviceName = "ProxyServer") {
    this.serviceName = serviceName;
    this.logBuffer = []; // 用于在内存中保存日志
    this.maxBufferSize = 100; // 最多保存100条
  }

  _formatMessage(level, message) {
    const timestamp = new Date().toISOString();
    const formatted = `[${level}] ${timestamp} [${this.serviceName}] - ${message}`;

    // 将格式化后的日志存入缓冲区
    this.logBuffer.push(formatted);
    // 如果缓冲区超过最大长度，则从头部删除旧的日志
    if (this.logBuffer.length > this.maxBufferSize) {
      this.logBuffer.shift();
    }

    return formatted;
  }

  info(message) {
    console.log(this._formatMessage("INFO", message));
  }
  error(message) {
    console.error(this._formatMessage("ERROR", message));
  }
  warn(message) {
    console.warn(this._formatMessage("WARN", message));
  }
  debug(message) {
    console.debug(this._formatMessage("DEBUG", message));
  }
}

class MessageQueue extends EventEmitter {
  constructor(timeoutMs = 600000) {
    super();
    this.messages = [];
    this.waitingResolvers = [];
    this.defaultTimeout = timeoutMs;
    this.closed = false;
  }
  enqueue(message) {
    if (this.closed) return;
    if (this.waitingResolvers.length > 0) {
      const resolver = this.waitingResolvers.shift();
      resolver.resolve(message);
    } else {
      this.messages.push(message);
    }
  }
  async dequeue(timeoutMs = this.defaultTimeout) {
    if (this.closed) {
      throw new Error("Queue is closed");
    }
    return new Promise((resolve, reject) => {
      if (this.messages.length > 0) {
        resolve(this.messages.shift());
        return;
      }
      const resolver = { resolve, reject };
      this.waitingResolvers.push(resolver);
      const timeoutId = setTimeout(() => {
        const index = this.waitingResolvers.indexOf(resolver);
        if (index !== -1) {
          this.waitingResolvers.splice(index, 1);
          reject(new Error("Queue timeout"));
        }
      }, timeoutMs);
      resolver.timeoutId = timeoutId;
    });
  }
  close() {
    this.closed = true;
    this.waitingResolvers.forEach((resolver) => {
      clearTimeout(resolver.timeoutId);
      resolver.reject(new Error("Queue closed"));
    });
    this.waitingResolvers = [];
    this.messages = [];
  }
}

class ConnectionRegistry extends EventEmitter {
  constructor(logger) {
    super();
    this.logger = logger;
    this.connections = new Set();
    this.messageQueues = new Map();
    this.reconnectGraceTimer = null; // 新增：用于缓冲期计时的定时器
  }
  addConnection(websocket, clientInfo) {
    // --- 核心修改：当新连接建立时，清除可能存在的“断开”警报 ---
    if (this.reconnectGraceTimer) {
      clearTimeout(this.reconnectGraceTimer);
      this.reconnectGraceTimer = null;
      this.logger.info("[Server] 在缓冲期内检测到新连接，已取消断开处理。");
    }
    // --- 修改结束 ---

    this.connections.add(websocket);
    this.logger.info(
      `[Server] 内部WebSocket客户端已连接 (来自: ${clientInfo.address})`
    );
    websocket.on("message", (data) =>
      this._handleIncomingMessage(data.toString())
    );
    websocket.on("close", () => this._removeConnection(websocket));
    websocket.on("error", (error) =>
      this.logger.error(`[Server] 内部WebSocket连接错误: ${error.message}`)
    );
    this.emit("connectionAdded", websocket);
  }

  _removeConnection(websocket) {
    this.connections.delete(websocket);
    this.logger.warn("[Server] 内部WebSocket客户端连接断开。");

    // --- 核心修改：不立即清理队列，而是启动一个缓冲期 ---
    this.logger.info("[Server] 启动5秒重连缓冲期...");
    this.reconnectGraceTimer = setTimeout(() => {
      // 5秒后，如果没有新连接进来（即reconnectGraceTimer未被清除），则确认是真实断开
      this.logger.error(
        "[Server] 缓冲期结束，未检测到重连。确认连接丢失，正在清理所有待处理请求..."
      );
      this.messageQueues.forEach((queue) => queue.close());
      this.messageQueues.clear();
      this.emit("connectionLost"); // 使用一个新的事件名，表示确认丢失
    }, 5000); // 5秒的缓冲时间
    // --- 修改结束 ---

    this.emit("connectionRemoved", websocket);
  }

  _handleIncomingMessage(messageData) {
    try {
      const parsedMessage = JSON.parse(messageData);
      const requestId = parsedMessage.request_id;
      if (!requestId) {
        this.logger.warn("[Server] 收到无效消息：缺少request_id");
        return;
      }
      const queue = this.messageQueues.get(requestId);
      if (queue) {
        this._routeMessage(parsedMessage, queue);
      } else {
        // 在缓冲期内，旧的请求队列可能仍然存在，但连接已经改变，这可能会导致找不到队列。
        // 暂时只记录警告，避免因竞速条件而报错。
        this.logger.warn(`[Server] 收到未知或已过时请求ID的消息: ${requestId}`);
      }
    } catch (error) {
      this.logger.error("[Server] 解析内部WebSocket消息失败");
    }
  }

  // 其他方法 (_routeMessage, hasActiveConnections, getFirstConnection,等) 保持不变...
  _routeMessage(message, queue) {
    const { event_type } = message;
    switch (event_type) {
      case "response_headers":
      case "chunk":
      case "error":
        queue.enqueue(message);
        break;
      case "stream_close":
        queue.enqueue({ type: "STREAM_END" });
        break;
      default:
        this.logger.warn(`[Server] 未知的内部事件类型: ${event_type}`);
    }
  }
  hasActiveConnections() {
    return this.connections.size > 0;
  }
  getFirstConnection() {
    return this.connections.values().next().value;
  }
  createMessageQueue(requestId) {
    const queue = new MessageQueue();
    this.messageQueues.set(requestId, queue);
    return queue;
  }
  removeMessageQueue(requestId) {
    const queue = this.messageQueues.get(requestId);
    if (queue) {
      queue.close();
      this.messageQueues.delete(requestId);
    }
  }
}

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
    this.maxTrafficLogs = 1000; // 最多保存1000条日志
  }

  get currentAuthIndex() {
    return this.browserManager.currentAuthIndex;
  }

  _getMaxAuthIndex() {
    return this.authSource.getMaxIndex();
  }

  _getNextAuthIndex() {
    const available = this.authSource.availableIndices; // 使用新的 availableIndices
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

    // --- 加锁！ ---
    this.isSystemBusy = true;
    this.isAuthSwitching = true;

    try {
      // 单账号模式 - 执行原地重启 (Refresh)
      if (available.length === 1) {
        const singleIndex = available[0];
        this.logger.info("==================================================");
        this.logger.info(
          `[Auth] 单账号模式：达到轮换阈值，正在执行原地重启...`
        );
        this.logger.info(`   • 目标账号: #${singleIndex}`);
        this.logger.info("==================================================");

        try {
          // 强制重新加载当前账号的 Context
          await this.browserManager.launchOrSwitchContext(singleIndex);

          // 关键：重置计数器
          this.failureCount = 0;
          this.usageCount = 0;

          this.logger.info(
            `[Auth] 单账号 #${singleIndex} 重启/刷新成功，使用计数已清零。`
          );
          return { success: true, newIndex: singleIndex };
        } catch (error) {
          this.logger.error(`[Auth] 单账号重启失败: ${error.message}`);
          throw error;
        }
      }

      // 多账号模式 - 执行轮换 (Rotate)

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
        this.logger.info(
          `[Auth] 成功切换到账号 #${this.currentAuthIndex}，计数已重置。`
        );
        return { success: true, newIndex: this.currentAuthIndex };
      } catch (error) {
        this.logger.error(
          `[Auth] 切换到账号 #${nextAuthIndex} 失败: ${error.message}`
        );
        this.logger.warn(
          `[Auth] 切换失败，正在尝试回退到上一个可用账号 #${previousAuthIndex}...`
        );
        try {
          await this.browserManager.launchOrSwitchContext(previousAuthIndex);
          this.logger.info(`[Auth] 成功回退到账号 #${previousAuthIndex}！`);
          this.failureCount = 0;
          this.usageCount = 0;
          this.logger.info("[Auth] 失败和使用计数已在回退成功后重置为0。");
          return {
            success: false,
            fallback: true,
            newIndex: this.currentAuthIndex,
          };
        } catch (fallbackError) {
          this.logger.error(
            `[Auth] FATAL: 紧急回退到账号 #${previousAuthIndex} 也失败了！服务可能中断。`
          );
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
      this.logger.info("[Auth] 正在切换账号，跳过重复操作");
      return { success: false, reason: "Switch already in progress." };
    }
    if (!this.authSource.availableIndices.includes(targetIndex)) {
      return {
        success: false,
        reason: `切换失败：账号 #${targetIndex} 无效或不存在。`,
      };
    }

    this.isSystemBusy = true;
    this.isAuthSwitching = true;
    try {
      this.logger.info(`[Auth] 开始切换到指定账号 #${targetIndex}...`);
      await this.browserManager.switchAccount(targetIndex);
      this.failureCount = 0;
      this.usageCount = 0;
      this.logger.info(
        `[Auth] 成功切换到账号 #${this.currentAuthIndex}，计数已重置。`
      );
      return { success: true, newIndex: this.currentAuthIndex };
    } catch (error) {
      this.logger.error(
        `[Auth] 切换到指定账号 #${targetIndex} 失败: ${error.message}`
      );
      // 对于指定切换，失败了就直接报错，不进行回退，让用户知道这个账号有问题
      throw error;
    } finally {
      this.isAuthSwitching = false;
      this.isSystemBusy = false;
    }
  }

  async _handleRequestFailureAndSwitch(errorDetails, res) {
    // 失败计数逻辑
    if (this.config.failureThreshold > 0) {
      this.failureCount++;
      this.logger.warn(
        `[Auth] 请求失败 - 失败计数: ${this.failureCount}/${this.config.failureThreshold} (当前账号索引: ${this.currentAuthIndex})`
      );
    }

    const isImmediateSwitch = this.config.immediateSwitchStatusCodes.includes(
      errorDetails.status
    );
    const isThresholdReached =
      this.config.failureThreshold > 0 &&
      this.failureCount >= this.config.failureThreshold;

    // 只要满足任一切换条件
    if (isImmediateSwitch || isThresholdReached) {
      if (isImmediateSwitch) {
        this.logger.warn(
          `[Auth] 收到状态码 ${errorDetails.status}，触发立即切换账号...`
        );
      } else {
        this.logger.warn(
          `[Auth] 达到失败阈值 (${this.failureCount}/${this.config.failureThreshold})！准备切换账号...`
        );
      }

      // [核心修改] 等待切换操作完成，并根据其结果发送不同消息
      try {
        await this._switchToNextAuth();
        // 如果上面这行代码没有抛出错误，说明切换/回退成功了
        const successMessage = `目标账户无效，已自动回退至账号 #${this.currentAuthIndex}。`;
        this.logger.info(`[Auth] ${successMessage}`);
        if (res) this._sendErrorChunkToClient(res, successMessage);
      } catch (error) {
        let userMessage = `致命错误：发生未知切换错误: ${error.message}`;

        if (error.message.includes("Only one account is available")) {
          // 场景：单账号无法切换
          userMessage = "切换失败：只有一个可用账号。";
          this.logger.info("[Auth] 只有一个可用账号，失败计数已重置。");
          this.failureCount = 0;
        } else if (error.message.includes("回退失败原因")) {
          // 场景：切换到坏账号后，连回退都失败了
          userMessage = `致命错误：自动切换和紧急回退均失败，服务可能已中断，请检查日志！`;
        } else if (error.message.includes("切换到账号")) {
          // 场景：切换到坏账号后，成功回退（这是一个伪“成功”，本质是上一个操作失败了）
          userMessage = `自动切换失败：已自动回退到账号 #${this.currentAuthIndex}，请检查目标账号是否存在问题。`;
        }

        this.logger.error(`[Auth] 后台账号切换任务最终失败: ${error.message}`);
        if (res) this._sendErrorChunkToClient(res, userMessage);
      }

      return;
    }
  }

  async processRequest(req, res) {
    const startTime = Date.now();
    let requestStatus = 200;
    let responseBody = null;  // 用于捕获响应体
    
    if (this.browserManager) {
      this.browserManager.notifyUserActivity();
    }
    const requestId = this._generateRequestId();
    let queueCancel = null;
    res.on("close", () => {
      if (!res.writableEnded) {
        this.logger.warn(
          `[Request] 客户端已提前关闭请求 #${requestId} 的连接。`
        );
        if (queueCancel) {
          queueCancel();
        }
        this._cancelBrowserRequest(requestId);
      }
    });
    const run = async () => {
      if (!this.connectionRegistry.hasActiveConnections()) {
        if (this.isSystemBusy) {
          this.logger.warn(
            "[System] 检测到连接断开，但系统正在进行切换/恢复，拒绝新请求。"
          );
          return this._sendErrorResponse(
            res,
            503,
            "服务器正在进行内部维护（账号切换/恢复），请稍后重试。"
          );
        }

        this.logger.error(
          "[System] 检测到浏览器WebSocket连接已断开！可能是进程崩溃。正在尝试恢复..."
        );
        // --- 开始恢复前，加锁！ ---
        this.isSystemBusy = true;
        try {
          await this.browserManager.launchOrSwitchContext(this.currentAuthIndex);
          this.logger.info(`[System] 浏览器已成功恢复！`);
        } catch (error) {
          this.logger.error(`[System] 浏览器自动恢复失败: ${error.message}`);
          return this._sendErrorResponse(
            res,
            503,
            "服务暂时不可用：后端浏览器实例崩溃且无法自动恢复，请联系管理员。"
          );
        } finally {
          // --- 恢复结束后，解锁！ ---
          this.isSystemBusy = false;
        }
      }

      if (this.isSystemBusy) {
        this.logger.warn(
          "[System] 收到新请求，但系统正在进行切换/恢复，拒绝新请求。"
        );
        return this._sendErrorResponse(
          res,
          503,
          "服务器正在进行内部维护（账号切换/恢复），请稍后重试。"
        );
      }

      const isGenerativeRequest =
        req.method === "POST" &&
        (req.path.includes("generateContent") ||
          req.path.includes("streamGenerateContent"));
      if (this.config.switchOnUses > 0 && isGenerativeRequest) {
        this.usageCount++;
        this.logger.info(
          `[Request] 生成请求 - 账号轮换计数: ${this.usageCount}/${this.config.switchOnUses} (当前账号: ${this.currentAuthIndex})`
        );
        if (this.usageCount >= this.config.switchOnUses) {
          this.needsSwitchingAfterRequest = true;
        }
      }

      const proxyRequest = this._buildProxyRequest(req, requestId);
      proxyRequest.is_generative = isGenerativeRequest;
      // 根据判断结果，为浏览器脚本准备标志位
      const messageQueue = this.connectionRegistry.createMessageQueue(requestId);
      const wantsStreamByHeader =
        req.headers.accept && req.headers.accept.includes("text/event-stream");
      const wantsStreamByPath = req.path.includes(":streamGenerateContent");
      const wantsStream = wantsStreamByHeader || wantsStreamByPath;

      try {
        if (wantsStream) {
          // --- 客户端想要流式响应 ---
          this.logger.info(
            `[Request] 客户端启用流式传输 (${this.serverSystem.streamingMode})，进入流式处理模式...`
          );
          if (this.serverSystem.streamingMode === "fake") {
            await this._handlePseudoStreamResponse(
              proxyRequest,
              messageQueue,
              req,
              res
            );
          } else {
            await this._handleRealStreamResponse(
              proxyRequest,
              messageQueue,
              res
            );
          }
        } else {
          proxyRequest.streaming_mode = "fake";
          responseBody = await this._handleNonStreamResponse(proxyRequest, messageQueue, res);
        }
      } catch (error) {
        this._handleRequestError(error, res);
      } finally {
        this.connectionRegistry.removeMessageQueue(requestId);
        if (this.needsSwitchingAfterRequest) {
          this.logger.info(
            `[Auth] 轮换计数已达到切换阈值 (${this.usageCount}/${this.config.switchOnUses})，将在后台自动切换账号...`
          );
          this._switchToNextAuth().catch((err) => {
            this.logger.error(`[Auth] 后台账号切换任务失败: ${err.message}`);
          });
          this.needsSwitchingAfterRequest = false;
        }
      }
    };

    const queueHandle = this._runWithConcurrency(requestId, run);
    if (queueHandle && queueHandle.cancel) {
      queueCancel = queueHandle.cancel;
    }
    if (queueHandle && queueHandle.promise) {
      await queueHandle.promise;
    }
    
    // 记录流量日志（processRequest）
    const duration = Date.now() - startTime;
    if (res.statusCode) requestStatus = res.statusCode;
    this._logTrafficRequest(req, requestStatus, duration, 0, responseBody);
  }

  async processOpenAIRequest(req, res) {
    const startTime = Date.now();
    let requestStatus = 200;
    let responseBody = null;
    if (this.browserManager) {
      this.browserManager.notifyUserActivity();
    }
    const requestId = this._generateRequestId();
    let queueCancel = null;
    res.on("close", () => {
      if (!res.writableEnded) {
        this.logger.warn(
          `[Request] 客户端已提前关闭请求 #${requestId} 的连接。`
        );
        if (queueCancel) {
          queueCancel();
        }
        this._cancelBrowserRequest(requestId);
      }
    });
    const isOpenAIStream = req.body.stream === true;
    const model = req.body.model || "gemini-1.5-pro-latest";
    const systemStreamMode = this.serverSystem.streamingMode;
    const useRealStream = isOpenAIStream && systemStreamMode === "real";
    let streamUsage = null;
    let streamContent = "";
    let streamReasoning = "";

    const parseSseJson = (chunk) => {
      if (!chunk || typeof chunk !== "string") return null;
      let jsonString = chunk.trim();
      if (jsonString.startsWith("data: ")) {
        jsonString = jsonString.substring(6).trim();
      }
      if (!jsonString || jsonString === "[DONE]") return null;
      try {
        return JSON.parse(jsonString);
      } catch (e) {
        return null;
      }
    };

    const extractUsageFromGoogleChunk = (chunk) => {
      const parsed = parseSseJson(chunk);
      if (!parsed || !parsed.usageMetadata) return null;
      const inputTokens = parsed.usageMetadata.promptTokenCount || 0;
      const outputTokens = parsed.usageMetadata.candidatesTokenCount || 0;
      const totalTokens = inputTokens + outputTokens;
      return {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: totalTokens,
      };
    };

    const extractUsageFromGoogleStreamBody = (body) => {
      if (!body || typeof body !== "string") return null;
      const parts = body.split("\n\n");
      for (let i = parts.length - 1; i >= 0; i--) {
        const usage = extractUsageFromGoogleChunk(parts[i]);
        if (usage) return usage;
      }
      return null;
    };

    const accumulateStreamContent = (chunk) => {
      const parsed = parseSseJson(chunk);
      if (!parsed || !parsed.choices || !parsed.choices[0]) return;
      const delta = parsed.choices[0].delta || {};
      if (delta.content) streamContent += delta.content;
      if (delta.reasoning_content) streamReasoning += delta.reasoning_content;
      if (parsed.usage) streamUsage = parsed.usage;
    };

    if (this.config.switchOnUses > 0) {
      this.usageCount++;
      this.logger.info(
        `[Request] OpenAI生成请求 - 账号轮换计数: ${this.usageCount}/${this.config.switchOnUses} (当前账号: ${this.currentAuthIndex})`
      );
      if (this.usageCount >= this.config.switchOnUses) {
        this.needsSwitchingAfterRequest = true;
      }
    }

    const run = async () => {
      let googleBody;
      try {
        googleBody = this._translateOpenAIToGoogle(req.body, model);
      } catch (error) {
        this.logger.error(`[Adapter] OpenAI请求翻译失败: ${error.message}`);
        return this._sendErrorResponse(
          res,
          400,
          "Invalid OpenAI request format."
        );
      }

      const googleEndpoint = useRealStream
        ? "streamGenerateContent"
        : "generateContent";
      const proxyRequest = {
        path: `/v1beta/models/${model}:${googleEndpoint}`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        query_params: useRealStream ? { alt: "sse" } : {},
        body: JSON.stringify(googleBody),
        request_id: requestId,
        is_generative: true,
        streaming_mode: useRealStream ? "real" : "fake",
      };

      const messageQueue = this.connectionRegistry.createMessageQueue(requestId);

      try {
        this._forwardRequest(proxyRequest);
        const initialMessage = await messageQueue.dequeue();

        if (initialMessage.event_type === "error") {
          this.logger.error(
            `[Adapter] 收到来自浏览器的错误，将触发切换逻辑。状态码: ${initialMessage.status}, 消息: ${initialMessage.message}`
          );
          await this._handleRequestFailureAndSwitch(initialMessage, res);
          if (isOpenAIStream) {
            if (!res.writableEnded) {
              res.write("data: [DONE]\n\n");
              res.end();
            }
          } else {
            this._sendErrorResponse(
              res,
              initialMessage.status || 500,
              initialMessage.message
            );
          }
          return;
        }

        if (this.failureCount > 0) {
          this.logger.info(
            `[Auth] OpenAI接口请求成功 - 失败计数已从 ${this.failureCount} 重置为 0`
          );
          this.failureCount = 0;
        }

        if (isOpenAIStream) {
          res.status(200).set({
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });

          if (useRealStream) {
            this.logger.info(`[Adapter] OpenAI 流式响应 (Real Mode) 已启动...`);
            let lastGoogleChunk = "";
            const streamState = { inThought: false };

            while (true) {
              const message = await messageQueue.dequeue(300000); // 5分钟超时
              if (message.type === "STREAM_END") {
                if (streamState.inThought) {
                  const closeThoughtPayload = {
                    id: `chatcmpl-${requestId}`,
                    object: "chat.completion.chunk",
                    created: Math.floor(Date.now() / 1000),
                    model: model,
                    choices: [
                      {
                        index: 0,
                        delta: { content: "\n</think>\n" },
                        finish_reason: null,
                      },
                    ],
                  };
                  res.write(`data: ${JSON.stringify(closeThoughtPayload)}\n\n`);
                }
                res.write("data: [DONE]\n\n");
                break;
              }
              if (message.data) {
                // [修改] 将 streamState 传递给翻译函数
                const translatedChunk = this._translateGoogleToOpenAIStream(
                  message.data,
                  model,
                  streamState
                );
                if (translatedChunk) {
                  res.write(translatedChunk);
                  accumulateStreamContent(translatedChunk);
                }
                lastGoogleChunk = message.data;
              }
            }
            if (!streamUsage) {
              streamUsage = extractUsageFromGoogleChunk(lastGoogleChunk);
            }
            responseBody = JSON.stringify({
              stream: true,
              content: streamContent || null,
              reasoning_content: streamReasoning || null,
              usage: streamUsage || null,
            });
          } else {
            this.logger.info(`[Adapter] OpenAI 流式响应 (Fake Mode) 已启动...`);

            let fullBody = "";
            while (true) {
              const message = await messageQueue.dequeue(300000);
              if (message.type === "STREAM_END") break;
              if (message.data) fullBody += message.data;
            }

            const translatedChunk = this._translateGoogleToOpenAIStream(
              fullBody,
              model
            );
            if (translatedChunk) {
              res.write(translatedChunk);
              accumulateStreamContent(translatedChunk);
            }
            if (!streamUsage) {
              streamUsage = extractUsageFromGoogleStreamBody(fullBody);
            }
            res.write("data: [DONE]\n\n");
            this.logger.info(
              `[Adapter] Fake模式：已一次性发送完整内容并结束流。`
            );
            responseBody = JSON.stringify({
              stream: true,
              content: streamContent || null,
              reasoning_content: streamReasoning || null,
              usage: streamUsage || null,
            });
          }
        } else {
          let fullBody = "";
          while (true) {
            const message = await messageQueue.dequeue(300000);
            if (message.type === "STREAM_END") {
              break;
            }
            if (message.event_type === "chunk" && message.data) {
              fullBody += message.data;
            }
          }

          const googleResponse = JSON.parse(fullBody);
          const candidate = googleResponse.candidates?.[0];

          let responseContent = "";
          let reasoningContent = "";
          let toolCalls = [];

          if (
            candidate &&
            candidate.content &&
            Array.isArray(candidate.content.parts)
          ) {
            const imagePart = candidate.content.parts.find((p) => p.inlineData);
            if (imagePart) {
              const image = imagePart.inlineData;
              responseContent = `![Generated Image](data:${image.mimeType};base64,${image.data})`;
              this.logger.info(
                "[Adapter] 从 parts.inlineData 中成功解析到图片。"
              );
            } else {
              candidate.content.parts.forEach((p) => {
                if (p.thought) {
                  reasoningContent += p.text || "";
                } else if (p.functionCall) {
                  const fnName = p.functionCall.name;
                  let args = p.functionCall.args;
                  let argsString = "";
                  if (typeof args === "string") {
                    argsString = args;
                  } else {
                    try {
                      argsString = JSON.stringify(args || {});
                    } catch (e) {
                      argsString = "{}";
                    }
                  }
                  toolCalls.push({
                    id: `call_${this._generateRequestId()}`,
                    type: "function",
                    function: {
                      name: fnName,
                      arguments: argsString,
                    },
                  });
                } else {
                  responseContent += p.text || "";
                }
              });
            }
          }

          var messageObj = {
            role: "assistant",
            content: responseContent,
          };

          if (toolCalls.length > 0) {
            messageObj.tool_calls = toolCalls;
            if (!responseContent) {
              messageObj.content = null;
            }
          }

          if (reasoningContent) {
            messageObj.reasoning_content = reasoningContent;
          }

          const openaiResponse = {
            id: `chatcmpl-${requestId}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: model,
            choices: [
              {
                index: 0,
                // 使用上面构建的 messageObj
                message: messageObj || { role: "assistant", content: "" },
                finish_reason:
                  toolCalls.length > 0
                    ? "tool_calls"
                    : candidate?.finishReason,
              },
            ],
          };

          if (googleResponse.usageMetadata) {
            const inputTokens = googleResponse.usageMetadata.promptTokenCount || 0;
            const outputTokens = googleResponse.usageMetadata.candidatesTokenCount || 0;
            openaiResponse.usage = {
              prompt_tokens: inputTokens,
              completion_tokens: outputTokens,
              total_tokens: inputTokens + outputTokens,
            };
          }

          const finishReason = candidate?.finishReason || "UNKNOWN";
          this.logger.info(
            `[Request] OpenAI非流式响应结束，原因: ${finishReason}，请求ID: ${requestId}`
          );

          responseBody = JSON.stringify(openaiResponse);  // 保存响应体用于日志记录
          res.status(200).json(openaiResponse);
        }
      } catch (error) {
        this._handleRequestError(error, res);
      } finally {
        this.connectionRegistry.removeMessageQueue(requestId);
        if (this.needsSwitchingAfterRequest) {
          this.logger.info(
            `[Auth] OpenAI轮换计数已达到切换阈值 (${this.usageCount}/${this.config.switchOnUses})，将在后台自动切换账号...`
          );
          this._switchToNextAuth().catch((err) => {
            this.logger.error(`[Auth] 后台账号切换任务失败: ${err.message}`);
          });
          this.needsSwitchingAfterRequest = false;
        }
        if (!res.writableEnded) {
          res.end();
        }
      }
    };

    const queueHandle = this._runWithConcurrency(requestId, run);
    if (queueHandle && queueHandle.cancel) {
      queueCancel = queueHandle.cancel;
    }
    if (queueHandle && queueHandle.promise) {
      await queueHandle.promise;
    }
    
    // 记录流量日志（processOpenAIRequest）
    const duration = Date.now() - startTime;
    if (res.statusCode) requestStatus = res.statusCode;
    this._logTrafficRequest(req, requestStatus, duration, 0, responseBody);
  }

  // --- 新增一个辅助方法，用于发送取消指令 ---
  _cancelBrowserRequest(requestId) {
    const connection = this.connectionRegistry.getFirstConnection();
    if (connection) {
      this.logger.info(
        `[Request] 正在向浏览器发送取消请求 #${requestId} 的指令...`
      );
      connection.send(
        JSON.stringify({
          event_type: "cancel_request",
          request_id: requestId,
        })
      );
    } else {
      this.logger.warn(
        `[Request] 无法发送取消指令：没有可用的浏览器WebSocket连接。`
      );
    }
  }

  _generateRequestId() {
    return `${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
  }

  // 记录流量日志
  _logTrafficRequest(req, status, duration, tokens = 0, responseBody = null) {
    try {
      // 提取模型名称
      let model = "unknown";
      const pathMatch = req.path.match(/models\/([^/:]+)/);
      if (pathMatch) {
        model = pathMatch[1];
      } else if (req.body && req.body.model) {
        model = req.body.model;
      }

      // 判断协议类型
      let protocol = "Google";
      if (req.path.includes("/chat/completions") || req.path.includes("/v1/")) {
        protocol = "OpenAI";
      }

      // 尝试从响应体中提取 token 信息
      let inputTokens = 0;
      let outputTokens = 0;
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
        } catch (e) {
          // 忽略解析错误
        }
      }

      const log = {
        id: this._generateRequestId(),
        timestamp: new Date().toISOString(),
        method: req.method,
        path: req.path,
        model: model,
        protocol: protocol,
        account: this.currentAuthIndex,
        status: status,
        statusText: status >= 200 && status < 300 ? "成功" : "失败",
        tokens: tokens,
        inputTokens: inputTokens,
        outputTokens: outputTokens,
        duration: duration,
        requestBody: req.body ? JSON.stringify(req.body) : null,
        responseBody: responseBody ? (typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody)) : null,
      };

      this.trafficLogs.push(log);

      // 限制日志数量
      if (this.trafficLogs.length > this.maxTrafficLogs) {
        this.trafficLogs = this.trafficLogs.slice(-this.maxTrafficLogs);
      }
    } catch (error) {
      this.logger.warn(`[Traffic] 记录流量日志失败: ${error.message}`);
    }
  }

  // 获取流量统计
  getTrafficStats() {
    const stats = {
      totalRequests: this.trafficLogs.length,
      successRequests: this.trafficLogs.filter((log) => log.status >= 200 && log.status < 300).length,
      errorRequests: this.trafficLogs.filter((log) => log.status >= 400).length,
      totalTokens: this.trafficLogs.reduce((sum, log) => sum + log.tokens, 0),
      avgDuration: this.trafficLogs.length > 0
        ? Math.round(
            this.trafficLogs.reduce((sum, log) => sum + log.duration, 0) /
              this.trafficLogs.length
          )
        : 0,
    };
    return {
      logs: this.trafficLogs.slice(-100).reverse(), // 返回最近100条，倒序
      stats: stats,
    };
  }

  _buildProxyRequest(req, requestId) {
    let bodyObj = req.body;
    if (
      this.serverSystem.forceThinking &&
      req.method === "POST" &&
      bodyObj &&
      bodyObj.contents
    ) {
      if (!bodyObj.generationConfig) {
        bodyObj.generationConfig = {};
      }

      if (!bodyObj.generationConfig.thinkingConfig) {
        this.logger.info(
          `[Proxy] (Google原生格式) 强制推理已启用，且客户端未提供配置，正在注入 thinkingConfig...`
        );
        bodyObj.generationConfig.thinkingConfig = { includeThoughts: true };
      } else {
        this.logger.info(
          `[Proxy] (Google原生格式) 检测到客户端自带推理配置，跳过强制注入。`
        );
      }
    }

    // 强制联网搜索和URL上下文 (Native Google Format)
    if (
      (this.serverSystem.forceWebSearch || this.serverSystem.forceUrlContext) &&
      req.method === "POST" &&
      bodyObj &&
      bodyObj.contents
    ) {
      if (!bodyObj.tools) {
        bodyObj.tools = [];
      }

      const toolsToAdd = [];

      // 处理 Google Search
      if (this.serverSystem.forceWebSearch) {
        const hasSearch = bodyObj.tools.some((t) => t.googleSearch);
        if (!hasSearch) {
          bodyObj.tools.push({googleSearch: {}});
          toolsToAdd.push("googleSearch");
        } else {
          this.logger.info(
            `[Proxy] (Google原生格式) 检测到客户端自带联网搜索，跳过强制注入。`
          );
        }
      }

      // 处理 URL Context
      if (this.serverSystem.forceUrlContext) {
        const hasUrlContext = bodyObj.tools.some((t) => t.urlContext);
        if (!hasUrlContext) {
          bodyObj.tools.push({urlContext: {}});
          toolsToAdd.push("urlContext");
        } else {
          this.logger.info(
            `[Proxy] (Google原生格式) 检测到客户端自带网址上下文，跳过强制注入。`
          );
        }
      }

      if (toolsToAdd.length > 0) {
        this.logger.info(
          `[Proxy] (Google原生格式) 强制功能已启用，正在注入工具: [${toolsToAdd.join(
            ", "
          )}]`
        );
      }
    }

    let requestBody = "";
    if (bodyObj) {
      requestBody = JSON.stringify(bodyObj);
    }

    return {
      path: req.path,
      method: req.method,
      headers: req.headers,
      query_params: req.query,
      body: requestBody,
      request_id: requestId,
      streaming_mode: this.serverSystem.streamingMode,
    };
  }
  _forwardRequest(proxyRequest) {
    const connection = this.connectionRegistry.getFirstConnection();
    if (connection) {
      connection.send(JSON.stringify(proxyRequest));
    } else {
      throw new Error("无法转发请求：没有可用的WebSocket连接。");
    }
  }
  _sendErrorChunkToClient(res, errorMessage) {
    const errorPayload = {
      error: {
        message: `[代理系统提示] ${errorMessage}`,
        type: "proxy_error",
        code: "proxy_error",
      },
    };
    const chunk = `data: ${JSON.stringify(errorPayload)}\n\n`;
    if (res && !res.writableEnded) {
      res.write(chunk);
      this.logger.info(`[Request] 已向客户端发送标准错误信号: ${errorMessage}`);
    }
  }

  async _handlePseudoStreamResponse(proxyRequest, messageQueue, req, res) {
    this.logger.info(
      "[Request] 客户端启用流式传输 (fake)，进入伪流式处理模式..."
    );
    res.status(200).set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const connectionMaintainer = setInterval(() => {
      if (!res.writableEnded) res.write(": keep-alive\n\n");
    }, 3000);

    try {
      let lastMessage,
        requestFailed = false;

      // 我们的重试循环（即使只跑一次）
      for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
        if (attempt > 1) {
          this.logger.info(
            `[Request] 请求尝试 #${attempt}/${this.maxRetries}...`
          );
        }
        this._forwardRequest(proxyRequest);
        try {
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error("Response from browser timed out after 300 seconds")
                ),
              300000
            )
          );
          lastMessage = await Promise.race([
            messageQueue.dequeue(),
            timeoutPromise,
          ]);
        } catch (timeoutError) {
          this.logger.error(`[Request] 致命错误: ${timeoutError.message}`);
          lastMessage = {
            event_type: "error",
            status: 504,
            message: timeoutError.message,
          };
        }

        if (lastMessage.event_type === "error") {
          // --- 核心修改：在这里就区分，避免打印不必要的“失败”日志 ---
          if (
            !(
              lastMessage.message &&
              lastMessage.message.includes("The user aborted a request")
            )
          ) {
            // 只有在不是“用户取消”的情况下，才打印“尝试失败”的警告
            this.logger.warn(
              `[Request] 尝试 #${attempt} 失败: 收到 ${
                lastMessage.status || "未知"
              } 错误。 - ${lastMessage.message}`
            );
          }

          if (attempt < this.maxRetries) {
            await new Promise((resolve) =>
              setTimeout(resolve, this.retryDelay)
            );
            continue;
          }
          requestFailed = true;
        }
        break;
      }

      // 处理最终结果
      if (requestFailed) {
        if (
          lastMessage.message &&
          lastMessage.message.includes("The user aborted a request")
        ) {
          this.logger.info(
            `[Request] 请求 #${proxyRequest.request_id} 已由用户妥善取消，不计入失败统计。`
          );
        } else {
          this.logger.error(
            `[Request] 所有 ${this.maxRetries} 次重试均失败，将计入失败统计。`
          );
          await this._handleRequestFailureAndSwitch(lastMessage, res);
          this._sendErrorChunkToClient(
            res,
            `请求最终失败: ${lastMessage.message}`
          );
        }
        return;
      }

      // 成功的逻辑
      if (proxyRequest.is_generative && this.failureCount > 0) {
        this.logger.info(
          `[Auth] 生成请求成功 - 失败计数已从 ${this.failureCount} 重置为 0`
        );
        this.failureCount = 0;
      }
      const dataMessage = await messageQueue.dequeue();
      const endMessage = await messageQueue.dequeue();
      if (dataMessage.data) {
        res.write(`data: ${dataMessage.data}\n\n`);
      }
      if (endMessage.type !== "STREAM_END") {
        this.logger.warn("[Request] 未收到预期的流结束信号。");
      }
      try {
        const fullResponse = JSON.parse(dataMessage.data);
        const finishReason =
          fullResponse.candidates?.[0]?.finishReason || "UNKNOWN";
        this.logger.info(
          `[Request] 响应结束，原因: ${finishReason}，请求ID: ${proxyRequest.request_id}`
        );
      } catch (e) {}
      res.write("data: [DONE]\n\n");
    } catch (error) {
      this._handleRequestError(error, res);
    } finally {
      clearInterval(connectionMaintainer);
      if (!res.writableEnded) {
        res.end();
      }
      this.logger.info(
        `[Request] 响应处理结束，请求ID: ${proxyRequest.request_id}`
      );
    }
  }

  async _handleRealStreamResponse(proxyRequest, messageQueue, res) {
    this.logger.info(`[Request] 请求已派发给浏览器端处理...`);
    this._forwardRequest(proxyRequest);
    const headerMessage = await messageQueue.dequeue();

    if (headerMessage.event_type === "error") {
      if (
        headerMessage.message &&
        headerMessage.message.includes("The user aborted a request")
      ) {
        this.logger.info(
          `[Request] 请求 #${proxyRequest.request_id} 已被用户妥善取消，不计入失败统计。`
        );
      } else {
        this.logger.error(`[Request] 请求失败，将计入失败统计。`);
        await this._handleRequestFailureAndSwitch(headerMessage, null);
        return this._sendErrorResponse(
          res,
          headerMessage.status,
          headerMessage.message
        );
      }
      if (!res.writableEnded) res.end();
      return;
    }

    // --- 核心修改：只有在生成请求成功时，才重置失败计数 ---
    if (proxyRequest.is_generative && this.failureCount > 0) {
      this.logger.info(
        `[Auth] 生成请求成功 - 失败计数已从 ${this.failureCount} 重置为 0`
      );
      this.failureCount = 0;
    }
    // --- 修改结束 ---

    this._setResponseHeaders(res, headerMessage);
    this.logger.info("[Request] 开始流式传输...");
    try {
      let lastChunk = "";
      while (true) {
        const dataMessage = await messageQueue.dequeue(30000);
        if (dataMessage.type === "STREAM_END") {
          this.logger.info("[Request] 收到流结束信号。");
          break;
        }
        if (dataMessage.data) {
          res.write(dataMessage.data);
          lastChunk = dataMessage.data;
        }
      }
      try {
        if (lastChunk.startsWith("data: ")) {
          const jsonString = lastChunk.substring(6).trim();
          if (jsonString) {
            const lastResponse = JSON.parse(jsonString);
            const finishReason =
              lastResponse.candidates?.[0]?.finishReason || "UNKNOWN";
            this.logger.info(
              `[Request] 响应结束，原因: ${finishReason}，请求ID: ${proxyRequest.request_id}`
            );
          }
        }
      } catch (e) {}
    } catch (error) {
      if (error.message !== "Queue timeout") throw error;
      this.logger.warn("[Request] 真流式响应超时，可能流已正常结束。");
    } finally {
      if (!res.writableEnded) res.end();
      this.logger.info(
        `[Request] 真流式响应连接已关闭，请求ID: ${proxyRequest.request_id}`
      );
    }
  }

  async _handleNonStreamResponse(proxyRequest, messageQueue, res) {
    this.logger.info(`[Request] 进入非流式处理模式...`);

    // 转发请求到浏览器端
    this._forwardRequest(proxyRequest);

    try {
      // 1. 等待响应头信息
      const headerMessage = await messageQueue.dequeue();
      if (headerMessage.event_type === "error") {
        // ... (错误处理逻辑保持不变)
        if (headerMessage.message?.includes("The user aborted a request")) {
          this.logger.info(
            `[Request] 请求 #${proxyRequest.request_id} 已被用户妥善取消。`
          );
        } else {
          this.logger.error(
            `[Request] 浏览器端返回错误: ${headerMessage.message}`
          );
          await this._handleRequestFailureAndSwitch(headerMessage, null);
        }
        return this._sendErrorResponse(
          res,
          headerMessage.status || 500,
          headerMessage.message
        );
      }

      // 2. 准备一个缓冲区，并确保循环等待直到收到结束信号
      let fullBody = "";
      while (true) {
        const message = await messageQueue.dequeue(300000);
        if (message.type === "STREAM_END") {
          this.logger.info("[Request] 收到结束信号，数据接收完毕。");
          break;
        }
        if (message.event_type === "chunk" && message.data) {
          fullBody += message.data;
        }
      }

      // 3. 重置失败计数器（如果需要）
      if (proxyRequest.is_generative && this.failureCount > 0) {
        this.logger.info(
          `[Auth] 非流式生成请求成功 - 失败计数已从 ${this.failureCount} 重置为 0`
        );
        this.failureCount = 0;
      }

      // [核心修正] 对Google原生格式的响应进行智能图片处理
      try {
        let parsedBody = JSON.parse(fullBody);
        let needsReserialization = false;

        const candidate = parsedBody.candidates?.[0];
        if (candidate?.content?.parts) {
          const imagePartIndex = candidate.content.parts.findIndex(
            (p) => p.inlineData
          );

          if (imagePartIndex > -1) {
            this.logger.info(
              "[Proxy] 检测到Google格式响应中的图片数据，正在转换为Markdown..."
            );
            const imagePart = candidate.content.parts[imagePartIndex];
            const image = imagePart.inlineData;

            // 创建一个新的 text part 来替换原来的 inlineData part
            const markdownTextPart = {
              text: `![Generated Image](data:${image.mimeType};base64,${image.data})`,
            };

            // 替换掉原来的部分
            candidate.content.parts[imagePartIndex] = markdownTextPart;
            needsReserialization = true;
          }
        }

        if (needsReserialization) {
          fullBody = JSON.stringify(parsedBody); // 如果处理了图片，重新序列化
        }
      } catch (e) {
        this.logger.warn(
          `[Proxy] 响应体不是有效的JSON，或在处理图片时出错: ${e.message}`
        );
        // 如果出错，则什么都不做，直接发送原始的 fullBody
      }

      try {
        const fullResponse = JSON.parse(fullBody);
        const finishReason =
          fullResponse.candidates?.[0]?.finishReason || "UNKNOWN";
        this.logger.info(
          `[Request] 响应结束，原因: ${finishReason}，请求ID: ${proxyRequest.request_id}`
        );
      } catch (e) {}

      // 4. 设置正确的JSON响应头，并一次性发送处理过的全部数据
      res
        .status(headerMessage.status || 200)
        .type("application/json")
        .send(fullBody || "{}");

      this.logger.info(`[Request] 已向客户端发送完整的非流式响应。`);
      
      // 返回响应体用于日志记录
      return fullBody;
    } catch (error) {
      this._handleRequestError(error, res);
      return null;
    }
  }

  _getKeepAliveChunk(req) {
    if (req.path.includes("chat/completions")) {
      const payload = {
        id: `chatcmpl-${this._generateRequestId()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "gpt-4",
        choices: [{ index: 0, delta: {}, finish_reason: null }],
      };
      return `data: ${JSON.stringify(payload)}\n\n`;
    }
    if (
      req.path.includes("generateContent") ||
      req.path.includes("streamGenerateContent")
    ) {
      const payload = {
        candidates: [
          {
            content: { parts: [{ text: "" }], role: "model" },
            finishReason: null,
            index: 0,
            safetyRatings: [],
          },
        ],
      };
      return `data: ${JSON.stringify(payload)}\n\n`;
    }
    return "data: {}\n\n";
  }

  _setResponseHeaders(res, headerMessage) {
    res.status(headerMessage.status || 200);
    const headers = headerMessage.headers || {};
    Object.entries(headers).forEach(([name, value]) => {
      if (name.toLowerCase() !== "content-length") res.set(name, value);
    });
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

  _sendErrorResponse(res, status, message) {
    if (!res.headersSent) {
      // 1. 创建一个符合API规范的JSON错误对象
      const errorPayload = {
        error: {
          code: status || 500,
          message: message,
          status: "SERVICE_UNAVAILABLE", // 这是一个示例状态名
        },
      };
      // 2. 设置响应类型为 application/json 并发送
      res
        .status(status || 500)
        .type("application/json")
        .send(JSON.stringify(errorPayload));
    }
  }

  _translateOpenAIToGoogle(openaiBody, modelName = "") {
    this.logger.info("[Adapter] 开始将OpenAI请求格式翻译为Google格式...");

    let systemInstruction = null;
    const googleContents = [];

    // --- Function Calling / Tools 预处理 ---
    const openaiTools = Array.isArray(openaiBody.tools) ? openaiBody.tools : [];
    const legacyFunctions = Array.isArray(openaiBody.functions)
      ? openaiBody.functions
      : [];
    const functionDeclarations = [];

    // 清理 parameters，移除不兼容的字段
    const cleanParameters = (params) => {
      if (!params || typeof params !== 'object') {
        return { type: "object" };
      }
      const cleaned = { ...params };
      // 删除 Google API 不接受的字段
      delete cleaned.$schema;
      delete cleaned.$id;
      delete cleaned.$ref;
      delete cleaned.$comment;
      delete cleaned.definitions;
      return cleaned;
    };

    openaiTools.forEach((tool) => {
      if (tool && tool.type === "function" && tool.function?.name) {
        functionDeclarations.push({
          name: tool.function.name,
          description: tool.function.description,
          parameters: cleanParameters(tool.function.parameters),
        });
      }
    });

    legacyFunctions.forEach((fn) => {
      if (fn && fn.name) {
        functionDeclarations.push({
          name: fn.name,
          description: fn.description,
          parameters: cleanParameters(fn.parameters),
        });
      }
    });

    const toolCallNameById = new Map();
    (openaiBody.messages || []).forEach((msg) => {
      if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
        msg.tool_calls.forEach((tc) => {
          if (tc?.id && tc?.function?.name) {
            toolCallNameById.set(tc.id, tc.function.name);
          }
        });
      }
    });

    // 1. 分离出 system 指令
    const systemMessages = openaiBody.messages.filter(
      (msg) => msg.role === "system"
    );
    if (systemMessages.length > 0) {
      // 将所有 system message 的内容合并
      const systemContent = systemMessages.map((msg) => msg.content).join("\n");
      systemInstruction = {
        // Google Gemini 1.5 Pro 开始正式支持 system instruction
        role: "system",
        parts: [{ text: systemContent }],
      };
    }

    // 2. 转换 user / assistant / tool 消息
    const conversationMessages = openaiBody.messages.filter(
      (msg) => msg.role !== "system"
    );
    for (const message of conversationMessages) {
      const googleParts = [];

      // [核心改进] 判断 content 是字符串还是数组
      if (typeof message.content === "string") {
        // a. 如果是纯文本
        googleParts.push({ text: message.content });
      } else if (Array.isArray(message.content)) {
        // b. 如果是图文混合内容
        for (const part of message.content) {
          if (part.type === "text") {
            googleParts.push({ text: part.text });
          } else if (part.type === "image_url" && part.image_url) {
            // 从 data URL 中提取 mimetype 和 base64 数据
            const dataUrl = part.image_url.url;
            const match = dataUrl.match(/^data:(image\/.*?);base64,(.*)$/);
            if (match) {
              googleParts.push({
                inlineData: {
                  mimeType: match[1],
                  data: match[2],
                },
              });
            }
          }
        }
      }

      // c. OpenAI 工具调用 (assistant.tool_calls / assistant.function_call)
      if (message.role === "assistant") {
        if (Array.isArray(message.tool_calls)) {
          message.tool_calls.forEach((toolCall) => {
            if (toolCall?.type === "function" && toolCall.function?.name) {
              let parsedArgs = toolCall.function.arguments;
              if (typeof parsedArgs === "string") {
                try {
                  parsedArgs = JSON.parse(parsedArgs);
                } catch (e) {
                  parsedArgs = { __raw: parsedArgs };
                }
              }
              googleParts.push({
                functionCall: {
                  name: toolCall.function.name,
                  args: parsedArgs || {},
                },
              });
            }
          });
        }

        if (message.function_call?.name) {
          let parsedArgs = message.function_call.arguments;
          if (typeof parsedArgs === "string") {
            try {
              parsedArgs = JSON.parse(parsedArgs);
            } catch (e) {
              parsedArgs = { __raw: parsedArgs };
            }
          }
          googleParts.push({
            functionCall: {
              name: message.function_call.name,
              args: parsedArgs || {},
            },
          });
        }
      }

      // d. OpenAI 工具响应 (role=tool / role=function)
      if (message.role === "tool" || message.role === "function") {
        const toolName =
          message.name || toolCallNameById.get(message.tool_call_id) || "tool";
        let toolResponse = message.content;
        if (typeof toolResponse === "string") {
          try {
            toolResponse = JSON.parse(toolResponse);
          } catch (e) {
            toolResponse = { content: toolResponse };
          }
        }
        googleParts.push({
          functionResponse: {
            name: toolName,
            response: toolResponse ?? {},
          },
        });
      }

      if (googleParts.length === 0) {
        continue;
      }

      googleContents.push({
        role: message.role === "assistant" ? "model" : "user",
        parts: googleParts,
      });
    }

    // 3. 构建最终的Google请求体
    const googleRequest = {
      contents: googleContents,
      ...(systemInstruction && {
        systemInstruction: { parts: systemInstruction.parts },
      }),
    };

    // 3.5. 注入 Function Declarations (Tools)
    if (functionDeclarations.length > 0) {
      if (!googleRequest.tools) googleRequest.tools = [];
      googleRequest.tools.push({ functionDeclarations });
    }

    // 4. 转换生成参数
    const generationConfig = {
      temperature: openaiBody.temperature,
      topP: openaiBody.top_p,
      topK: openaiBody.top_k,
      maxOutputTokens: openaiBody.max_tokens,
      stopSequences: openaiBody.stop,
    };

    const extraBody = openaiBody.extra_body || {};
    let rawThinkingConfig =
      extraBody.google?.thinking_config ||
      extraBody.google?.thinkingConfig ||
      extraBody.thinkingConfig ||
      extraBody.thinking_config ||
      openaiBody.thinkingConfig ||
      openaiBody.thinking_config;

    let thinkingConfig = null;

    if (rawThinkingConfig) {
      // 2. 格式清洗：将 snake_case (下划线) 转换为 camelCase (驼峰)
      thinkingConfig = {};

      // 处理开关
      if (rawThinkingConfig.include_thoughts !== undefined) {
        thinkingConfig.includeThoughts = rawThinkingConfig.include_thoughts;
      } else if (rawThinkingConfig.includeThoughts !== undefined) {
        thinkingConfig.includeThoughts = rawThinkingConfig.includeThoughts;
      }

      // 处理 Budget (预算)
      // if (rawThinkingConfig.thinking_budget !== undefined) {
      // thinkingConfig.thinkingBudgetTokenLimit =
      // rawThinkingConfig.thinking_budget;
      //} else if (rawThinkingConfig.thinkingBudget !== undefined) {
      //thinkingConfig.thinkingBudgetTokenLimit =
      //rawThinkingConfig.thinkingBudget;
      //}

      this.logger.info(
        `[Adapter] 成功提取并转换推理配置: ${JSON.stringify(thinkingConfig)}`
      );
    }

    // 3. 如果没找到配置，尝试识别 OpenAI 标准参数 'reasoning_effort'
    if (!thinkingConfig) {
      const effort = openaiBody.reasoning_effort || extraBody.reasoning_effort;
      if (effort) {
        this.logger.info(
          `[Adapter] 检测到 OpenAI 标准推理参数 (reasoning_effort: ${effort})，自动转换为 Google 格式。`
        );
        thinkingConfig = { includeThoughts: true };
      }
    }

    // 4. 强制开启逻辑 (WebUI开关)
    if (this.serverSystem.forceThinking && !thinkingConfig) {
      this.logger.info(
        "[Adapter] 强制推理已启用，且客户端未提供配置，正在注入 thinkingConfig..."
      );
      thinkingConfig = { includeThoughts: true };
    }

    // 5. 写入最终配置
    if (thinkingConfig) {
      generationConfig.thinkingConfig = thinkingConfig;
    }

    googleRequest.generationConfig = generationConfig;

    // 4.5. Tool Choice / Function Call 配置
    const toolChoice =
      openaiBody.tool_choice !== undefined
        ? openaiBody.tool_choice
        : openaiBody.function_call;

    if (toolChoice !== undefined) {
      let functionCallingConfig = null;

      if (toolChoice === "none") {
        functionCallingConfig = { mode: "NONE" };
      } else if (toolChoice === "auto") {
        functionCallingConfig = { mode: "AUTO" };
      } else if (toolChoice === "required") {
        const allowed = functionDeclarations.map((f) => f.name).filter(Boolean);
        functionCallingConfig = {
          mode: "ANY",
          ...(allowed.length > 0 ? { allowedFunctionNames: allowed } : {}),
        };
      } else if (typeof toolChoice === "object") {
        const fnName = toolChoice.function?.name || toolChoice.name;
        if (fnName) {
          functionCallingConfig = {
            mode: "ANY",
            allowedFunctionNames: [fnName],
          };
        }
      }

      if (functionCallingConfig) {
        googleRequest.toolConfig = { functionCallingConfig };
      }
    }

    // 5. 安全设置
    googleRequest.safetySettings = [
      { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
    ];

    // 强制联网搜索和URL上下文
    if (
      (this.serverSystem.forceWebSearch || this.serverSystem.forceUrlContext)
    ) {
      if (!googleRequest.tools) {
        googleRequest.tools = [];
      }

      const toolsToAdd = [];

      // 处理 Google Search
      if (this.serverSystem.forceWebSearch) {
        const hasSearch = googleRequest.tools.some((t) => t.googleSearch);
        if (!hasSearch) {
          googleRequest.tools.push({googleSearch: {}});
          toolsToAdd.push("googleSearch");
        }
      }

      // 处理 URL Context
      if (this.serverSystem.forceUrlContext) {
        const hasUrlContext = googleRequest.tools.some((t) => t.urlContext);
        if (!hasUrlContext) {
          googleRequest.tools.push({urlContext: {}});
          toolsToAdd.push("urlContext");
        }
      }

      if (toolsToAdd.length > 0) {
        this.logger.info(
          `[Adapter] 强制功能已启用，正在注入工具: [${toolsToAdd.join(
            ", "
          )}]`
        );
      }
    }

    // 6. 工具过滤：只保留 Gemini API 支持的工具类型
    if (googleRequest.tools && Array.isArray(googleRequest.tools)) {
      const validToolKeys = [
        'functionDeclarations',
        'googleSearchRetrieval', 
        'codeExecution',
        'googleSearch',
        'computerUse',
        'urlContext',
        'fileSearch',
        'googleMaps'
      ];

      const originalToolsCount = googleRequest.tools.length;
      googleRequest.tools = googleRequest.tools.map(tool => {
        // 过滤掉不在有效列表中的工具字段
        const filteredTool = {};
        for (const key of Object.keys(tool)) {
          if (validToolKeys.includes(key)) {
            filteredTool[key] = tool[key];
          } else {
            this.logger.warn(
              `[Adapter] 检测到不支持的工具类型 "${key}"，已自动剔除。`
            );
          }
        }
        return filteredTool;
      }).filter(tool => Object.keys(tool).length > 0); // 移除空对象

      if (googleRequest.tools.length < originalToolsCount) {
        this.logger.info(
          `[Adapter] 工具过滤完成：原始 ${originalToolsCount} 个，保留 ${googleRequest.tools.length} 个有效工具。`
        );
      }

      // 如果过滤后没有任何工具，则删除 tools 字段
      if (googleRequest.tools.length === 0) {
        delete googleRequest.tools;
        this.logger.info('[Adapter] 所有工具均被过滤，已移除 tools 字段。');
      }
    }

    this.logger.info("[Adapter] 翻译完成。");
    return googleRequest;
  }

  _translateGoogleToOpenAIStream(
    googleChunk,
    modelName = "gemini-pro",
    streamState = null
  ) {
    if (!googleChunk || googleChunk.trim() === "") {
      return null;
    }

    if (!streamState) {
      streamState = { toolCallIds: new Map(), toolCallIndex: 0 };
    }

    let jsonString = googleChunk;
    if (jsonString.startsWith("data: ")) {
      jsonString = jsonString.substring(6).trim();
    }

    if (!jsonString || jsonString === "[DONE]") return null;

    let googleResponse;
    try {
      googleResponse = JSON.parse(jsonString);
    } catch (e) {
      this.logger.warn(`[Adapter] 无法解析Google返回的JSON块: ${jsonString}`);
      return null;
    }

    const candidate = googleResponse.candidates?.[0];
    if (!candidate) {
      if (googleResponse.promptFeedback) {
        this.logger.warn(
          `[Adapter] Google返回了promptFeedback，可能已被拦截: ${JSON.stringify(
            googleResponse.promptFeedback
          )}`
        );
        const errorText = `[ProxySystem Error] 请求因为安全原因被拒绝。拒绝具体原因: ${googleResponse.promptFeedback.blockReason}`;
        return `data: ${JSON.stringify({
          id: `chatcmpl-${this._generateRequestId()}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: modelName,
          choices: [
            { index: 0, delta: { content: errorText }, finish_reason: "stop" },
          ],
        })}\n\n`;
      }
      return null;
    }

    const delta = {};
    const toolCalls = [];

    if (candidate.content && Array.isArray(candidate.content.parts)) {
      const imagePart = candidate.content.parts.find((p) => p.inlineData);

      if (imagePart) {
        const image = imagePart.inlineData;
        delta.content = `![Generated Image](data:${image.mimeType};base64,${image.data})`;
        this.logger.info("[Adapter] 从流式响应块中成功解析到图片。");
      } else {
        // 遍历所有部分，分离思考内容和正文内容
        let contentAccumulator = "";
        let reasoningAccumulator = "";

        for (const part of candidate.content.parts) {
          // Google API 的 thought 标记
          if (part.thought === true) {
            reasoningAccumulator += part.text || "";
          } else if (part.functionCall) {
            const fnName = part.functionCall.name;
            let args = part.functionCall.args;
            let argsString = "";
            if (typeof args === "string") {
              argsString = args;
            } else {
              try {
                argsString = JSON.stringify(args || {});
              } catch (e) {
                argsString = "{}";
              }
            }

            let toolCallId = streamState.toolCallIds.get(fnName);
            if (!toolCallId) {
              toolCallId = `call_${this._generateRequestId()}`;
              streamState.toolCallIds.set(fnName, toolCallId);
            }
            const toolCallIndex = streamState.toolCallIndex || 0;
            if (!streamState.toolCallIds.has(`index:${fnName}`)) {
              streamState.toolCallIds.set(`index:${fnName}`, toolCallIndex);
              streamState.toolCallIndex = toolCallIndex + 1;
            }
            const indexValue = streamState.toolCallIds.get(`index:${fnName}`);
            toolCalls.push({
              index: indexValue,
              id: toolCallId,
              type: "function",
              function: {
                name: fnName,
                arguments: argsString,
              },
            });
          } else {
            contentAccumulator += part.text || "";
          }
        }

        // 只有当有内容时才添加到 delta 中
        if (reasoningAccumulator) {
          delta.reasoning_content = reasoningAccumulator;
        }
        if (contentAccumulator) {
          delta.content = contentAccumulator;
        }
      }
    }

    if (toolCalls.length > 0) {
      delta.tool_calls = toolCalls;
    }

    // 如果没有任何内容变更，则不返回数据（避免空行）
    if (
      !delta.content &&
      !delta.reasoning_content &&
      !delta.tool_calls &&
      !candidate.finishReason
    ) {
      return null;
    }

    const openaiResponse = {
      id: `chatcmpl-${this._generateRequestId()}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: modelName,
      choices: [
        {
          index: 0,
          delta: delta, // 使用包含 reasoning_content 的 delta
          finish_reason:
            candidate.finishReason && delta.tool_calls
              ? "tool_calls"
              : candidate.finishReason || null,
        },
      ],
    };

    return `data: ${JSON.stringify(openaiResponse)}\n\n`;
  }
}

class ProxyServerSystem extends EventEmitter {
  constructor() {
    super();
    this.logger = new LoggingService("ProxySystem");
    
    // 使用新的配置加载器
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

  _loadConfiguration() {
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
    };

    const configPath = path.join(__dirname, "config.json");
    try {
      if (fs.existsSync(configPath)) {
        const fileConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        config = { ...config, ...fileConfig };
        this.logger.info("[System] 已从 config.json 加载配置。");
      }
    } catch (error) {
      this.logger.warn(`[System] 无法读取或解析 config.json: ${error.message}`);
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

    let rawCodes = process.env.IMMEDIATE_SWITCH_STATUS_CODES;
    let codesSource = "环境变量";

    if (
      !rawCodes &&
      config.immediateSwitchStatusCodes &&
      Array.isArray(config.immediateSwitchStatusCodes)
    ) {
      rawCodes = config.immediateSwitchStatusCodes.join(",");
      codesSource = "config.json 文件或默认值";
    }

    if (rawCodes && typeof rawCodes === "string") {
      config.immediateSwitchStatusCodes = rawCodes
        .split(",")
        .map((code) => parseInt(String(code).trim(), 10))
        .filter((code) => !isNaN(code) && code >= 400 && code <= 599);
      if (config.immediateSwitchStatusCodes.length > 0) {
        this.logger.info(`[System] 已从 ${codesSource} 加载“立即切换报错码”。`);
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

    // [修改] 更新API密钥来源的判断逻辑
    if (config.apiKeys.length > 0) {
      config.apiKeySource = "自定义";
    } else {
      config.apiKeys = ["123456"];
      config.apiKeySource = "默认";
      this.logger.info("[System] 未设置任何API Key，已启用默认密码: 123456");
    }

    const modelsPath = path.join(__dirname, "models.json");
    try {
      if (fs.existsSync(modelsPath)) {
        const modelsFileContent = fs.readFileSync(modelsPath, "utf-8");
        config.modelList = JSON.parse(modelsFileContent); // 将读取到的模型列表存入config对象
        this.logger.info(
          `[System] 已从 models.json 成功加载 ${config.modelList.length} 个模型。`
        );
      } else {
        this.logger.warn(
          `[System] 未找到 models.json 文件，将使用默认模型列表。`
        );
        config.modelList = ["gemini-1.5-pro-latest"]; // 提供一个备用模型，防止服务启动失败
      }
    } catch (error) {
      this.logger.error(
        `[System] 读取或解析 models.json 失败: ${error.message}，将使用默认模型列表。`
      );
      config.modelList = ["gemini-1.5-pro-latest"]; // 出错时也使用备用模型
    }

    this.config = config;
    this.logger.info("================ [ 生效配置 ] ================");
    this.logger.info(`HTTP 服务端口: ${this.config.httpPort}`);
    this.logger.info(`监听地址: ${this.config.host}`);
    this.logger.info(`流式模式: ${this.config.streamingMode}`);
    this.logger.info(
      `轮换计数切换阈值: ${
        this.config.switchOnUses > 0
          ? `每 ${this.config.switchOnUses} 次请求后切换`
          : "已禁用"
      }`
    );
    this.logger.info(
      `失败计数切换: ${
        this.config.failureThreshold > 0
          ? `失败${this.config.failureThreshold} 次后切换`
          : "已禁用"
      }`
    );
    this.logger.info(
      `立即切换报错码: ${
        this.config.immediateSwitchStatusCodes.length > 0
          ? this.config.immediateSwitchStatusCodes.join(", ")
          : "已禁用"
      }`
    );
    this.logger.info(`单次请求最大重试: ${this.config.maxRetries}次`);
    this.logger.info(`重试间隔: ${this.config.retryDelay}ms`);
    this.logger.info(
      `最大并发请求: ${this.config.maxConcurrentRequests}`
    );
    this.logger.info(`  API 密钥来源: ${this.config.apiKeySource}`); // 在启动日志中也显示出来
    this.logger.info(
      "============================================================="
    );
  }

  async start(initialAuthIndex = null) {
    // <<<--- 1. 重新接收参数
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

    // 2. <<<--- 创建一个优先尝试的启动顺序列表 --->>>
    let startupOrder = [...allAvailableIndices];
    if (initialAuthIndex && allAvailableIndices.includes(initialAuthIndex)) {
      this.logger.info(
        `[System] 检测到指定启动索引 #${initialAuthIndex}，将优先尝试。`
      );
      // 将指定索引放到数组第一位，其他索引保持原状
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
      this.logger.info(
        `[System] 未指定有效启动索引，将按默认顺序 [${startupOrder.join(
          ", "
        )}] 尝试。`
      );
    }

    let isStarted = false;
    // 3. <<<--- 遍历这个新的、可能被重排过的顺序列表 --->>>
    for (const index of startupOrder) {
      try {
        this.logger.info(`[System] 尝试使用账号 #${index} 启动服务...`);
        await this.browserManager.launchOrSwitchContext(index);

        isStarted = true;
        this.logger.info(`[System] 使用账号 #${index} 成功启动！`);
        break; // 成功启动，跳出循环
      } catch (error) {
        this.logger.error(
          `[System] 使用账号 #${index} 启动失败。原因: ${error.message}`
        );
        // 失败了，循环将继续，尝试下一个账号
      }
    }

    if (!isStarted) {
      // 如果所有账号都尝试失败了
      throw new Error("所有认证源均尝试失败，服务器无法启动。");
    }
    this.logger.info(`[System] 代理服务器系统启动完成。`);
    this.emit("started");
  }

  _createAuthMiddleware() {
    const basicAuth = require("basic-auth"); // 确保此行存在，为admin认证提供支持

    return (req, res, next) => {
      const serverApiKeys = this.config.apiKeys;
      if (!serverApiKeys || serverApiKeys.length === 0) {
        return next();
      }

      let clientKey = null;
      if (req.headers["x-goog-api-key"]) {
        clientKey = req.headers["x-goog-api-key"];
      } else if (
        req.headers.authorization &&
        req.headers.authorization.startsWith("Bearer ")
      ) {
        clientKey = req.headers.authorization.substring(7);
      } else if (req.headers["x-api-key"]) {
        clientKey = req.headers["x-api-key"];
      } else if (req.query.key) {
        clientKey = req.query.key;
      }

      if (clientKey && serverApiKeys.includes(clientKey)) {
        this.logger.info(
          `[Auth] API Key验证通过 (来自: ${
            req.headers["x-forwarded-for"] || req.ip
          })`
        );
        if (req.query.key) {
          delete req.query.key;
        }
        return next();
      }

      // 对于没有有效API Key的请求，返回401错误
      // 注意：健康检查等逻辑已在_createExpressApp中提前处理
      if (req.path !== "/favicon.ico") {
        const clientIp = req.headers["x-forwarded-for"] || req.ip;
        this.logger.warn(
          `[Auth] 访问密码错误或缺失，已拒绝请求。IP: ${clientIp}, Path: ${req.path}`
        );
      }

      return res.status(401).json({
        error: {
          message:
            "Access denied. A valid API key was not found or is incorrect.",
        },
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
        this.logger.info(
          `[System] Keep-Alive 超时已设置为 ${
            this.httpServer.keepAliveTimeout / 1000
          } 秒。`
        );
        resolve();
      });
    });
  }

  _createExpressApp() {
    const app = express();

    app.use((req, res, next) => {
      res.header("Access-Control-Allow-Origin", "*");
      res.header(
        "Access-Control-Allow-Methods",
        "GET, POST, PUT, DELETE, PATCH, OPTIONS"
      );
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

    app.use((req, res, next) => {
      if (
        req.path !== "/api/status" &&
        req.path !== "/" &&
        req.path !== "/favicon.ico" &&
        req.path !== "/login"
      ) {
        this.logger.info(
          `[Entrypoint] 收到一个请求: ${req.method} ${req.path}`
        );
      }
      next();
    });
    app.use(express.json({ limit: "100mb" }));
    app.use(express.urlencoded({ extended: true }));

    const sessionSecret =
      // Section 1 & 2 (核心中间件和登录路由) 保持不变...
      (this.config.apiKeys && this.config.apiKeys[0]) ||
      crypto.randomBytes(20).toString("hex");
    app.use(cookieParser());
    app.use(
      session({
        secret: sessionSecret,
        resave: false,
        saveUninitialized: true,
        cookie: { secure: false, maxAge: 86400000 },
      })
    );
    const isAuthenticated = (req, res, next) => {
      // 检查 session 认证
      if (req.session.isAuthenticated) {
        return next();
      }
      
      // 检查当前是否处于未初始化状态 (Keys 为空或包含空字符串)
      // 如果未初始化，且请求是配置相关的操作，允许通过
      const hasValidKeys = this.config.apiKeys && 
                          this.config.apiKeys.length > 0 && 
                          this.config.apiKeys.some(k => k && String(k).trim() !== "");
                          
      if (!hasValidKeys && req.path.startsWith("/api/config")) {
        this.logger.info(`[Auth] 系统未初始化，临时允许 ${req.method} ${req.path} 请求以进行设置`);
        return next();
      }
      
      // 检查 x-api-key header 认证（用于 API 调用）
      const apiKey = req.headers["x-api-key"];
      
      if (apiKey && this.config.apiKeys.includes(apiKey)) {
        return next();
      }
      
      // 如果都不满足，根据请求类型返回不同的响应
      const acceptHeader = req.headers.accept || "";
      if (acceptHeader.includes("application/json") || req.path.startsWith("/api/")) {
        // API 请求返回 JSON 错误
        return res.status(401).json({
          error: { message: "未授权：请提供有效的 API Key" }
        });
      } else {
        // 浏览器请求重定向到登录页面
        res.redirect("/login");
      }
    };
    app.get("/login", (req, res) => {
      if (req.session.isAuthenticated) {
        return res.redirect("/");
      }
      const loginHtml = `
      <!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>登录</title>
      <style>body{display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;background:#f0f2f5}form{background:white;padding:40px;border-radius:10px;box-shadow:0 4px 8px rgba(0,0,0,0.1);text-align:center}input{width:250px;padding:10px;margin-top:10px;border:1px solid #ccc;border-radius:5px}button{width:100%;padding:10px;background-color:#007bff;color:white;border:none;border-radius:5px;margin-top:20px;cursor:pointer}.error{color:red;margin-top:10px}</style>
      </head><body><form action="/login" method="post"><h2>请输入 API Key</h2>
      <input type="password" name="apiKey" placeholder="API Key" required autofocus><button type="submit">登录</button>
      ${
        req.query.error ? '<p class="error">API Key 错误!</p>' : ""
      }</form></body></html>`;
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

    // ==========================================================
    // Section 3: 状态页面 和 API (最终版)
    // ==========================================================
    app.get("/", isAuthenticated, (req, res) => {
      const { config, requestHandler, authSource, browserManager } = this;
      const initialIndices = authSource.initialIndices || [];
      const availableIndices = authSource.availableIndices || [];
      const invalidIndices = initialIndices.filter(
        (i) => !availableIndices.includes(i)
      );
      const logs = this.logger.logBuffer || [];

      const accountNameMap = authSource.accountNameMap;
      const accountDetailsHtml = initialIndices
        .map((index) => {
          const isInvalid = invalidIndices.includes(index);
          const name = isInvalid
            ? "N/A (JSON格式错误)"
            : accountNameMap.get(index) || "N/A (未命名)";
          return `<span class="label" style="padding-left: 20px;">账号${index}</span>: ${name}`;
        })
        .join("\n");

      const accountOptionsHtml = availableIndices
        .map((index) => `<option value="${index}">账号 #${index}</option>`)
        .join("");

      const statusHtml = `
    <!DOCTYPE html>
    <html lang="zh-CN">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>代理服务状态</title>
        <style>
        body { font-family: 'SF Mono', 'Consolas', 'Menlo', monospace; background-color: #f0f2f5; color: #333; padding: 2em; }
        .container { max-width: 800px; margin: 0 auto; background: #fff; padding: 1em 2em 2em 2em; border-radius: 12px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
        h1, h2 { color: #333; border-bottom: 2px solid #eee; padding-bottom: 0.5em;}
        pre { background: #2d2d2d; color: #f0f0f0; font-size: 1.1em; padding: 1.5em; border-radius: 8px; white-space: pre-wrap; word-wrap: break-word; line-height: 1.6; }
        #log-container { font-size: 0.9em; max-height: 400px; overflow-y: auto; }
        .status-ok { color: #2ecc71; font-weight: bold; }
        .status-error { color: #e74c3c; font-weight: bold; }
        .label { display: inline-block; width: 220px; box-sizing: border-box; }
        .dot { height: 10px; width: 10px; background-color: #bbb; border-radius: 50%; display: inline-block; margin-left: 10px; animation: blink 1s infinite alternate; }
        @keyframes blink { from { opacity: 0.3; } to { opacity: 1; } }
        .action-group { display: flex; flex-wrap: wrap; gap: 15px; align-items: center; }
        .action-group button, .action-group select { font-size: 1em; border: 1px solid #ccc; padding: 10px 15px; border-radius: 8px; cursor: pointer; transition: background-color 0.3s ease; }
        .action-group button:hover { opacity: 0.85; }
        .action-group button { background-color: #007bff; color: white; border-color: #007bff; }
        .action-group select { background-color: #ffffff; color: #000000; -webkit-appearance: none; appearance: none; }
        @media (max-width: 600px) {
            body { padding: 0.5em; }
            .container { padding: 1em; margin: 0; }
            pre { padding: 1em; font-size: 0.9em; }
            .label { width: auto; display: inline; }
            .action-group { flex-direction: column; align-items: stretch; }
            .action-group select, .action-group button { width: 100%; box-sizing: border-box; }
        }
        </style>
    </head>
    <body>
        <div class="container">
        <h1>代理服务状态 <span class="dot" title="数据动态刷新中..."></span></h1>
        <div id="status-section">
            <pre>
<span class="label">服务状态</span>: <span class="status-ok">Running</span>
<span class="label">浏览器连接</span>: <span class="${
        browserManager.browser ? "status-ok" : "status-error"
      }">${!!browserManager.browser}</span>
--- 服务配置 ---
<span class="label">流模式</span>: ${
        config.streamingMode
      } (仅启用流式传输时生效)
<span class="label">最大并发</span>: ${config.maxConcurrentRequests}
<span class="label">在途请求</span>: ${requestHandler.activeRequests}
<span class="label">排队请求</span>: ${requestHandler.pendingRequests.length}
<span class="label">强制推理</span>: ${
        this.forceThinking ? "已启用" : "已关闭"
      }
<span class="label">强制联网</span>: ${
        this.forceWebSearch ? "已启用" : "已关闭"
      }
<span class="label">强制网址上下文</span>: ${
        this.forceUrlContext ? "已启用" : "已关闭"
      }
<span class="label">立即切换 (状态码)</span>: ${
        config.immediateSwitchStatusCodes.length > 0
          ? `[${config.immediateSwitchStatusCodes.join(", ")}]`
          : "已禁用"
      }
<span class="label">API 密钥</span>: ${config.apiKeySource}
--- 账号状态 ---
<span class="label">当前使用账号</span>: #${requestHandler.currentAuthIndex}
<span class="label">使用次数计数</span>: ${requestHandler.usageCount} / ${
        config.switchOnUses > 0 ? config.switchOnUses : "N/A"
      }
<span class="label">连续失败计数</span>: ${requestHandler.failureCount} / ${
        config.failureThreshold > 0 ? config.failureThreshold : "N/A"
      }
<span class="label">扫描到的总帐号</span>: [${initialIndices.join(
        ", "
      )}] (总数: ${initialIndices.length})
      ${accountDetailsHtml}
<span class="label">格式错误 (已忽略)</span>: [${invalidIndices.join(
        ", "
      )}] (总数: ${invalidIndices.length})
            </pre>
        </div>
        <div id="actions-section" style="margin-top: 2em;">
            <h2>操作面板</h2>
            <div class="action-group">
                <select id="accountIndexSelect">${accountOptionsHtml}</select>
                <button onclick="switchSpecificAccount()">切换账号</button>
                <button onclick="toggleStreamingMode()">切换流模式</button>
                <button onclick="toggleForceThinking()">切换强制推理</button>
                <button onclick="toggleForceWebSearch()">切换强制联网</button>
                <button onclick="toggleForceUrlContext()">切换强制网址上下文</button>
                <button onclick="openConfigEditor()" style="background-color: #28a745;">配置编辑</button>
            </div>
        </div>
        <div id="config-editor-section" style="margin-top: 2em; display: none;">
            <h2>配置编辑器</h2>
            <div style="margin-bottom: 1em;">
                <button onclick="closeConfigEditor()" style="background-color: #6c757d;">关闭</button>
                <button onclick="saveConfigChanges()" style="background-color: #28a745;">保存配置</button>
                <button onclick="resetConfigEditor()" style="background-color: #ffc107;">重置</button>
            </div>
            <div style="background: #2d2d2d; padding: 1em; border-radius: 8px;">
                <textarea id="config-editor" style="width: 100%; min-height: 500px; font-family: 'SF Mono', 'Consolas', monospace; background: #1e1e1e; color: #d4d4d4; border: 1px solid #444; padding: 10px; border-radius: 4px; font-size: 14px;"></textarea>
            </div>
        </div>
        <div id="log-section" style="margin-top: 2em;">
            <h2>实时日志 (最近 ${logs.length} 条)</h2>
            <pre id="log-container">${logs.join("\n")}</pre>
        </div>
        </div>
        <script>
        function updateContent() {
            fetch('/api/status').then(response => response.json()).then(data => {
                const statusPre = document.querySelector('#status-section pre');
                const accountDetailsHtml = data.status.accountDetails.map(acc => {
                  return '<span class="label" style="padding-left: 20px;">账号' + acc.index + '</span>: ' + acc.name;
                }).join('\\n');
                statusPre.innerHTML = 
                    '<span class="label">服务状态</span>: <span class="status-ok">Running</span>\\n' +
                    '<span class="label">浏览器连接</span>: <span class="' + (data.status.browserConnected ? "status-ok" : "status-error") + '">' + data.status.browserConnected + '</span>\\n' +
                    '--- 服务配置 ---\\n' +
                    '<span class="label">流模式</span>: ' + data.status.streamingMode + '\\n' +
                    '<span class="label">最大并发</span>: ' + data.status.maxConcurrentRequests + '\n' +
                    '<span class="label">在途请求</span>: ' + data.status.activeRequests + '\n' +
                    '<span class="label">排队请求</span>: ' + data.status.pendingRequests + '\n' +
                    '<span class="label">强制推理</span>: ' + data.status.forceThinking + '\\n' +
                    '<span class="label">强制联网</span>: ' + data.status.forceWebSearch + '\\n' +
                    '<span class="label">强制网址上下文</span>: ' + data.status.forceUrlContext + '\\n' +
                    '<span class="label">立即切换 (状态码)</span>: ' + data.status.immediateSwitchStatusCodes + '\\n' +
                    '<span class="label">API 密钥</span>: ' + data.status.apiKeySource + '\\n' +
                    '--- 账号状态 ---\\n' +
                    '<span class="label">当前使用账号</span>: #' + data.status.currentAuthIndex + '\\n' +
                    '<span class="label">使用次数计数</span>: ' + data.status.usageCount + '\\n' +
                    '<span class="label">连续失败计数</span>: ' + data.status.failureCount + '\\n' +
                    '<span class="label">扫描到的总账号</span>: ' + data.status.initialIndices + '\\n' +
                    accountDetailsHtml + '\\n' +
                    '<span class="label">格式错误 (已忽略)</span>: ' + data.status.invalidIndices;
                
                const logContainer = document.getElementById('log-container');
                const logTitle = document.querySelector('#log-section h2');
                const isScrolledToBottom = logContainer.scrollHeight - logContainer.clientHeight <= logContainer.scrollTop + 1;
                logTitle.innerText = \`实时日志 (最近 \${data.logCount} 条)\`;
                logContainer.innerText = data.logs;
                if (isScrolledToBottom) { logContainer.scrollTop = logContainer.scrollHeight; }
            }).catch(error => console.error('Error fetching new content:', error));
        }

        function switchSpecificAccount() {
            const selectElement = document.getElementById('accountIndexSelect');
            const targetIndex = selectElement.value;
            if (!confirm(\`确定要切换到账号 #\${targetIndex} 吗？这会重置浏览器会话。\`)) {
                return;
            }
            fetch('/api/switch-account', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ targetIndex: parseInt(targetIndex, 10) })
            })
            .then(res => res.text()).then(data => { alert(data); updateContent(); })
            .catch(err => { 
                if (err.message.includes('Load failed') || err.message.includes('NetworkError')) {
                    alert('浏览器启动较慢，操作仍在后台进行中。\\n\\n请不要重复点击。');
                } else {
                    alert('操作失败: ' + err); 
                }
                updateContent(); 
            });
        }
            
        function toggleStreamingMode() { 
            const newMode = prompt('请输入新的流模式 (real 或 fake):', '${
              this.config.streamingMode
            }');
            if (newMode === 'fake' || newMode === 'real') {
                fetch('/api/set-mode', { 
                    method: 'POST', 
                    headers: { 'Content-Type': 'application/json' }, 
                    body: JSON.stringify({ mode: newMode }) 
                })
                .then(res => res.text()).then(data => { alert(data); updateContent(); })
                .catch(err => alert('设置失败: ' + err));
            } else if (newMode !== null) { 
                alert('无效的模式！请只输入 "real" 或 "fake"。'); 
            } 
        }

        function toggleForceThinking() {
            fetch('/api/toggle-force-thinking', { 
                method: 'POST', 
                headers: { 'Content-Type': 'application/json' }
            })
            .then(res => res.text()).then(data => { alert(data); updateContent(); })
            .catch(err => alert('设置失败: ' + err));
        }

        function toggleForceWebSearch() {
            fetch('/api/toggle-force-web-search', { 
                method: 'POST', 
                headers: { 'Content-Type': 'application/json' }
            })
            .then(res => res.text()).then(data => { alert(data); updateContent(); })
            .catch(err => alert('设置失败: ' + err));
        }

        function toggleForceUrlContext() {
            fetch('/api/toggle-force-url-context', { 
                method: 'POST', 
                headers: { 'Content-Type': 'application/json' }
            })
            .then(res => res.text()).then(data => { alert(data); updateContent(); })
            .catch(err => alert('设置失败: ' + err));
            res.status(200).send(\`强制网址上下文: \${statusText}\`);
        }

        let originalConfigText = '';

        function openConfigEditor() {
            fetch('/api/config')
                .then(res => res.json())
                .then(config => {
                    // 将配置转换为YAML格式显示
                    const yamlText = convertToYAML(config);
                    originalConfigText = yamlText;
                    document.getElementById('config-editor').value = yamlText;
                    document.getElementById('config-editor-section').style.display = 'block';
                    document.getElementById('config-editor-section').scrollIntoView({ behavior: 'smooth' });
                })
                .catch(err => alert('加载配置失败: ' + err));
        }

        function closeConfigEditor() {
            if (confirm('确定要关闭配置编辑器吗？未保存的更改将丢失。')) {
                document.getElementById('config-editor-section').style.display = 'none';
            }
        }

        function resetConfigEditor() {
            if (confirm('确定要重置为原始配置吗？')) {
                document.getElementById('config-editor').value = originalConfigText;
            }
        }

        function saveConfigChanges() {
            const yamlText = document.getElementById('config-editor').value;
            
            try {
                // 尝试将YAML解析为JSON
                const config = parseYAML(yamlText);
                
                fetch('/api/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(config)
                })
                .then(res => res.json())
                .then(data => {
                    if (data.success) {
                        alert('配置已保存并重新加载！\\n\\n页面将在3秒后刷新。');
                        setTimeout(() => location.reload(), 3000);
                    } else {
                        alert('保存失败: ' + (data.error || '未知错误'));
                    }
                })
                .catch(err => alert('保存配置失败: ' + err));
            } catch (err) {
                alert('配置格式错误: ' + err.message + '\\n\\n请检查YAML语法是否正确。');
            }
        }

        // 简单的YAML转换函数
        function convertToYAML(obj, indent = 0) {
            let yaml = '';
            const spaces = '  '.repeat(indent);
            
            for (const [key, value] of Object.entries(obj)) {
                if (value === null || value === undefined) {
                    yaml += \`\${spaces}\${key}:\\n\`;
                } else if (typeof value === 'object' && !Array.isArray(value)) {
                    yaml += \`\${spaces}\${key}:\\n\`;
                    yaml += convertToYAML(value, indent + 1);
                } else if (Array.isArray(value)) {
                    yaml += \`\${spaces}\${key}:\\n\`;
                    value.forEach(item => {
                        if (typeof item === 'object') {
                            yaml += \`\${spaces}  -\\n\`;
                            yaml += convertToYAML(item, indent + 2);
                        } else {
                            yaml += \`\${spaces}  - \${typeof item === 'string' ? '"' + item + '"' : item}\\n\`;
                        }
                    });
                } else if (typeof value === 'string') {
                    yaml += \`\${spaces}\${key}: "\${value}"\\n\`;
                } else {
                    yaml += \`\${spaces}\${key}: \${value}\\n\`;
                }
            }
            return yaml;
        }

        // 简单的YAML解析函数（基本实现）
        function parseYAML(yamlText) {
            const lines = yamlText.split('\\n');
            const result = {};
            const stack = [{ obj: result, indent: -1 }];
            let currentArray = null;
            
            for (let line of lines) {
                // 跳过空行和注释
                if (!line.trim() || line.trim().startsWith('#')) continue;
                
                const indent = line.search(/\\S/);
                const content = line.trim();
                
                // 处理数组项
                if (content.startsWith('- ')) {
                    const value = content.substring(2).trim();
                    const parsed = parseValue(value);
                    if (currentArray) {
                        currentArray.push(parsed);
                    }
                    continue;
                }
                
                // 处理键值对
                const colonIndex = content.indexOf(':');
                if (colonIndex === -1) continue;
                
                const key = content.substring(0, colonIndex).trim();
                const valueStr = content.substring(colonIndex + 1).trim();
                
                // 调整栈
                while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
                    stack.pop();
                }
                
                const parent = stack[stack.length - 1].obj;
                
                if (valueStr === '') {
                    // 空值，可能是对象或数组
                    const nextLine = lines[lines.indexOf(line) + 1];
                    if (nextLine && nextLine.trim().startsWith('- ')) {
                        parent[key] = [];
                        currentArray = parent[key];
                    } else {
                        parent[key] = {};
                        stack.push({ obj: parent[key], indent: indent });
                        currentArray = null;
                    }
                } else {
                    parent[key] = parseValue(valueStr);
                    currentArray = null;
                }
            }
            
            return result;
        }

        function parseValue(str) {
            str = str.trim();
            // 移除引号
            if ((str.startsWith('"') && str.endsWith('"')) || 
                (str.startsWith("'") && str.endsWith("'"))) {
                return str.slice(1, -1);
            }
            // 布尔值
            if (str === 'true') return true;
            if (str === 'false') return false;
            // 数字
            if (!isNaN(str) && str !== '') return Number(str);
            // 字符串
            return str;
        }

        document.addEventListener('DOMContentLoaded', () => {
            updateContent(); 
            setInterval(updateContent, 5000);
        });
        </script>
    </body>
    </html>
    `;
      res.status(200).send(statusHtml);
    });

    app.get("/api/status", isAuthenticated, (req, res) => {
      const { config, requestHandler, authSource, browserManager } = this;
      const initialIndices = authSource.initialIndices || [];
      const invalidIndices = initialIndices.filter(
        (i) => !authSource.availableIndices.includes(i)
      );
      const logs = this.logger.logBuffer || [];
      const accountNameMap = authSource.accountNameMap;
      const accountDetails = initialIndices.map((index) => {
        const isInvalid = invalidIndices.includes(index);
        const name = isInvalid
          ? "N/A (JSON格式错误)"
          : accountNameMap.get(index) || "N/A (未命名)";
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
          usageCount: `${requestHandler.usageCount} / ${
            config.switchOnUses > 0 ? config.switchOnUses : "N/A"
          }`,
          failureCount: `${requestHandler.failureCount} / ${
            config.failureThreshold > 0 ? config.failureThreshold : "N/A"
          }`,
          initialIndices: `[${initialIndices.join(", ")}] (总数: ${
            initialIndices.length
          })`,
          accountDetails: accountDetails,
          invalidIndices: `[${invalidIndices.join(", ")}] (总数: ${
            invalidIndices.length
          })`,
        },
        logs: logs.join("\n"),
        logCount: logs.length,
      };
      res.json(data);
    });

    // 获取流量统计
    app.get("/api/traffic", isAuthenticated, (req, res) => {
      try {
        const trafficData = this.requestHandler.getTrafficStats();
        res.json(trafficData);
      } catch (error) {
        this.logger.error(`[API] 获取流量统计失败: ${error.message}`);
        res.status(500).json({
          error: "获取流量统计失败",
          message: error.message,
        });
      }
    });

    // 获取模型列表
    app.get("/api/models", isAuthenticated, (req, res) => {
      try {
        const modelsPath = path.join(__dirname, "models.json");
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
        res.status(500).json({
          error: "获取模型列表失败",
          message: error.message,
        });
      }
    });

    app.post("/api/switch-account", isAuthenticated, async (req, res) => {
      try {
        const { targetIndex } = req.body;
        if (targetIndex !== undefined && targetIndex !== null) {
          this.logger.info(
            `[WebUI] 收到切换到指定账号 #${targetIndex} 的请求...`
          );
          const result = await this.requestHandler._switchToSpecificAuth(
            targetIndex
          );
          if (result.success) {
            res.status(200).send(`切换成功！已激活账号 #${result.newIndex}。`);
          } else {
            res.status(400).send(result.reason);
          }
        } else {
          this.logger.info("[WebUI] 收到手动切换下一个账号的请求...");
          if (this.authSource.availableIndices.length <= 1) {
            return res
              .status(400)
              .send("切换操作已取消：只有一个可用账号，无法切换。");
          }
          const result = await this.requestHandler._switchToNextAuth();
          if (result.success) {
            res
              .status(200)
              .send(`切换成功！已切换到账号 #${result.newIndex}。`);
          } else if (result.fallback) {
            res
              .status(200)
              .send(`切换失败，但已成功回退到账号 #${result.newIndex}。`);
          } else {
            res.status(409).send(`操作未执行: ${result.reason}`);
          }
        }
      } catch (error) {
        res
          .status(500)
          .send(`致命错误：操作失败！请检查日志。错误: ${error.message}`);
      }
    });
    app.post("/api/set-mode", isAuthenticated, (req, res) => {
      const newMode = req.body.mode;
      if (newMode === "fake" || newMode === "real") {
        this.streamingMode = newMode;
        this.logger.info(
          `[WebUI] 流式模式已由认证用户切换为: ${this.streamingMode}`
        );
        res.status(200).send(`流式模式已切换为: ${this.streamingMode}`);
      } else {
        res.status(400).send('无效模式. 请用 "fake" 或 "real".');
      }
    });

    app.post("/api/toggle-force-thinking", isAuthenticated, (req, res) => {
      this.forceThinking = !this.forceThinking;
      const statusText = this.forceThinking ? "已启用" : "已关闭";
      this.logger.info(`[WebUI] 强制推理开关已切换为: ${statusText}`);
      res.status(200).send(`强制推理模式: ${statusText}`);
    });

    app.post("/api/toggle-force-web-search", isAuthenticated, (req, res) => {
      this.forceWebSearch = !this.forceWebSearch;
      const statusText = this.forceWebSearch ? "已启用" : "已关闭";
      this.logger.info(`[WebUI] 强制联网搜索开关已切换为: ${statusText}`);
      res.status(200).send(`强制联网搜索: ${statusText}`);
    });

    app.post("/api/toggle-force-url-context", isAuthenticated, (req, res) => {
      this.forceUrlContext = !this.forceUrlContext;
      const statusText = this.forceUrlContext ? "已启用" : "已关闭";
      this.logger.info(`[WebUI] 强制网址上下文开关已切换为: ${statusText}`);
      res.status(200).send(`强制网址上下文: ${statusText}`);
    });

    // 获取完整配置
    app.get("/api/config", isAuthenticated, (req, res) => {
      try {
        const config = readConfig();
        if (!config) {
          return res.status(404).json({
            error: "配置文件不存在"
          });
        }
        res.json(config);
      } catch (error) {
        this.logger.error(`[API] 读取配置失败: ${error.message}`);
        res.status(500).json({
          error: error.message
        });
      }
    });

    // 保存完整配置
    app.post("/api/config", isAuthenticated, (req, res) => {
      try {
        const newConfig = req.body;
        
        if (!newConfig || typeof newConfig !== 'object') {
          return res.status(400).json({
            error: "无效的配置数据"
          });
        }
        
        // 保存配置到文件
        saveConfig(newConfig);
        
        // 重新加载配置
        this.config = loadConfiguration(this.logger);
        this.streamingMode = this.config.streamingMode;
        this.forceThinking = this.config.forceThinking;
        this.forceWebSearch = this.config.forceWebSearch;
        this.forceUrlContext = this.config.forceUrlContext;
        
        this.logger.info("[WebUI] 配置已更新并重新加载");
        
        res.json({
          success: true,
          message: "配置已保存并重新加载"
        });
      } catch (error) {
        this.logger.error(`[API] 保存配置失败: ${error.message}`);
        res.status(500).json({
          error: error.message
        });
      }
    });

    app.post("/api/upload-auth", isAuthenticated, (req, res) => {
      const { storageState, accountName, targetIndex } = req.body || {};

      if (!storageState) {
        return res.status(400).json({
          error: {
            message: "缺少 storageState。请在请求体中提供 storageState 对象或JSON字符串。",
          },
        });
      }

      let parsedState = storageState;
      if (typeof storageState === "string") {
        try {
          parsedState = JSON.parse(storageState);
        } catch (e) {
          return res.status(400).json({
            error: {
              message: `storageState 不是合法JSON: ${e.message}`,
            },
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

      const authDir = path.join(__dirname, "auth");
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
          `[Auth] 当前为环境变量模式，已写入文件 ${path.basename(
            authFilePath
          )}，但不会自动生效。`
        );
      } else {
        this.authSource.refresh();
      }

      this.logger.info(
        `[Auth] 已上传并写入认证文件: auth-${indexToWrite}.json`
      );

      return res.status(200).json({
        success: true,
        index: indexToWrite,
        file: authFilePath,
        mode: this.authSource.authMode,
      });
    });

    app.use(this._createAuthMiddleware());

    app.get("/v1/models", (req, res) => {
      const modelIds = this.config.modelList || ["gemini-2.5-pro"];

      const models = modelIds.map((id) => ({
        id: id,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "google",
      }));

      res.status(200).json({
        object: "list",
        data: models,
      });
    });

    app.post("/v1/chat/completions", (req, res) => {
      this.requestHandler.processOpenAIRequest(req, res);
    });
    
    // 代理所有非管理API的请求到 Google API
    // 排除 /api/* 管理端点，避免被转发到浏览器
    app.all(/^(?!\/api\/)(.*)/, (req, res) => {
      this.requestHandler.processRequest(req, res);
    });

    return app;
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

// ===================================================================================
// MAIN INITIALIZATION
// ===================================================================================

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

if (require.main === module) {
  initializeServer();
}

module.exports = { ProxyServerSystem, BrowserManager, initializeServer };

