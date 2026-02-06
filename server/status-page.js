/**
 * 状态页面模块
 * 生成 WebUI 状态页面的 HTML
 */

module.exports = function generateStatusPage(serverSystem) {
    const { config, requestHandler, authSource, browserManager } = serverSystem;
    const initialIndices = authSource.initialIndices || [];
    const availableIndices = authSource.availableIndices || [];
    const invalidIndices = initialIndices.filter((i) => !availableIndices.includes(i));
    const logs = serverSystem.logger.logBuffer || [];

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

    return `
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
<span class="label">浏览器连接</span>: <span class="${browserManager.browser ? "status-ok" : "status-error"}">${!!browserManager.browser}</span>
--- 服务配置 ---
<span class="label">流模式</span>: ${config.streamingMode} (仅启用流式传输时生效)
<span class="label">最大并发</span>: ${config.maxConcurrentRequests}
<span class="label">在途请求</span>: ${requestHandler.activeRequests}
<span class="label">排队请求</span>: ${requestHandler.pendingRequests.length}
<span class="label">强制推理</span>: ${serverSystem.forceThinking ? "已启用" : "已关闭"}
<span class="label">强制联网</span>: ${serverSystem.forceWebSearch ? "已启用" : "已关闭"}
<span class="label">强制网址上下文</span>: ${serverSystem.forceUrlContext ? "已启用" : "已关闭"}
<span class="label">立即切换 (状态码)</span>: ${config.immediateSwitchStatusCodes.length > 0 ? `[${config.immediateSwitchStatusCodes.join(", ")}]` : "已禁用"}
<span class="label">API 密钥</span>: ${config.apiKeySource}
--- 账号状态 ---
<span class="label">当前使用账号</span>: #${requestHandler.currentAuthIndex}
<span class="label">使用次数计数</span>: ${requestHandler.usageCount} / ${config.switchOnUses > 0 ? config.switchOnUses : "N/A"}
<span class="label">连续失败计数</span>: ${requestHandler.failureCount} / ${config.failureThreshold > 0 ? config.failureThreshold : "N/A"}
<span class="label">扫描到的总帐号</span>: [${initialIndices.join(", ")}] (总数: ${initialIndices.length})
      ${accountDetailsHtml}
<span class="label">格式错误 (已忽略)</span>: [${invalidIndices.join(", ")}] (总数: ${invalidIndices.length})
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
                '<span class="label">最大并发</span>: ' + data.status.maxConcurrentRequests + '\\n' +
                '<span class="label">在途请求</span>: ' + data.status.activeRequests + '\\n' +
                '<span class="label">排队请求</span>: ' + data.status.pendingRequests + '\\n' +
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
        const newMode = prompt('请输入新的流模式 (real 或 fake):', '${config.streamingMode}');
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
    }

    let originalConfigText = '';

    function openConfigEditor() {
        fetch('/api/config')
            .then(res => res.json())
            .then(config => {
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

    function parseYAML(yamlText) {
        const lines = yamlText.split('\\n');
        const result = {};
        const stack = [{ obj: result, indent: -1 }];
        let currentArray = null;
        
        for (let line of lines) {
            if (!line.trim() || line.trim().startsWith('#')) continue;
            
            const indent = line.search(/\\S/);
            const content = line.trim();
            
            if (content.startsWith('- ')) {
                const value = content.substring(2).trim();
                const parsed = parseValue(value);
                if (currentArray) {
                    currentArray.push(parsed);
                }
                continue;
            }
            
            const colonIndex = content.indexOf(':');
            if (colonIndex === -1) continue;
            
            const key = content.substring(0, colonIndex).trim();
            const valueStr = content.substring(colonIndex + 1).trim();
            
            while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
                stack.pop();
            }
            
            const parent = stack[stack.length - 1].obj;
            
            if (valueStr === '') {
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
        if ((str.startsWith('"') && str.endsWith('"')) || 
            (str.startsWith("'") && str.endsWith("'"))) {
            return str.slice(1, -1);
        }
        if (str === 'true') return true;
        if (str === 'false') return false;
        if (!isNaN(str) && str !== '') return Number(str);
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
};
