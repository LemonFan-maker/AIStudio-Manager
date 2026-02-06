/**
 * 浏览器管理模块
 * 管理 Playwright 浏览器实例和页面交互
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { firefox } = require("playwright");

// 获取项目根目录
const ROOT_DIR = path.join(__dirname, "..");

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
                    ROOT_DIR,
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
            path.join(ROOT_DIR, this.scriptFileName),
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
                    } catch (e) { }
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
                    } catch (e) { }
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
                    } catch (e) { }
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
                                ROOT_DIR,
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
                await currentPage.bringToFront().catch(() => { });

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
                    } catch (e) { }
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
                        `[Browser] 锁定目标 [${targetInfo.tagName}] (策略: ${targetInfo.strategy === "precise_css" ? "精准定位" : "模糊扫描"
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

module.exports = { BrowserManager };
