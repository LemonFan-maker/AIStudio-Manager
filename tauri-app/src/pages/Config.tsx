import { useEffect, useState } from "react";
import { api, SystemStatus } from "@/lib/api";
import { Settings, Save, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

interface ConfigData {
  server?: {
    httpPort?: number;
    host?: string;
    wsPort?: number;
  };
  apiKeys?: string[];
  streaming?: {
    mode?: string;
  };
  features?: {
    forceThinking?: boolean;
    forceWebSearch?: boolean;
    forceUrlContext?: boolean;
  };
  accountSwitching?: {
    failureThreshold?: number;
    switchOnUses?: number;
    immediateSwitchStatusCodes?: number[];
  };
  retry?: {
    maxRetries?: number;
    retryDelay?: number;
  };
  concurrency?: {
    maxConcurrentRequests?: number;
  };
  browser?: {
    executablePath?: string;
    initialAuthIndex?: number;
  };
}

export default function Config() {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [config, setConfig] = useState<ConfigData | null>(null);
  const [apiKeys, setApiKeys] = useState<string[]>([""]);
  const [showInitialSetup, setShowInitialSetup] = useState(false);
  const [tempApiKey, setTempApiKey] = useState("");
  const [apiBaseUrl, setApiBaseUrl] = useState("");

  const normalizeHost = (host?: string) => {
    if (!host || host.trim() === "") return "127.0.0.1";
    if (host === "0.0.0.0") return "127.0.0.1";
    return host;
  };

  const buildBaseUrl = (host?: string, port?: number) => {
    const safeHost = normalizeHost(host);
    const safePort = port || 7860;
    return `http://${safeHost}:${safePort}`;
  };

  const fetchStatus = async () => {
    try {
      const data = await api.getStatus();
      setStatus(data.status);
      setLoading(false);
    } catch (err) {
      console.error("获取状态失败:", err);
      setLoading(false);
    }
  };

  const fetchConfig = async () => {
    try {
      const configData = await api.getConfig();
      setConfig(configData);
      if (configData.apiKeys && configData.apiKeys.length > 0) {
        setApiKeys(configData.apiKeys);
      }
      // 同步前端连接地址到后端配置中的 host/port
      if (configData.server) {
        const nextBaseUrl = buildBaseUrl(
          configData.server.host,
          configData.server.httpPort
        );
        api.saveBaseUrl(nextBaseUrl);
        setApiBaseUrl(nextBaseUrl);
      }
      setShowInitialSetup(false);
    } catch (err: any) {
      console.error("获取配置失败:", err);
      const errorMessage = err.message || "";
      
      // 如果是认证失败，强制登出
      if (errorMessage.includes("未授权") || errorMessage.includes("401")) {
        api.saveApiKey("");
        setShowInitialSetup(true);
        setMessage({ type: "error", text: "认证已失效，请重新输入 API Key" });
        return;
      }

      // 如果获取配置失败，可能是因为没有 API Key
      const savedKey = api.getSavedApiKey();
      if (!savedKey || savedKey === "") {
        setShowInitialSetup(true);
      } else {
        // 如果有 Key 但连接失败，加载默认配置以解除 UI 锁定
        if (!config) {
            setConfig({
              server: {
                httpPort: 7860,
                host: "0.0.0.0",
                wsPort: 9998
              },
              apiKeys: [savedKey],
              streaming: {
                mode: "real"
              },
              features: {
                forceThinking: false,
                forceWebSearch: false,
                forceUrlContext: false
              },
              accountSwitching: {
                failureThreshold: 3,
                switchOnUses: 40,
                immediateSwitchStatusCodes: [429, 503]
              },
              retry: {
                maxRetries: 1,
                retryDelay: 2000
              },
              concurrency: {
                maxConcurrentRequests: 3
              },
              browser: {
                executablePath: "",
                initialAuthIndex: 1
              }
            });
            // 同步 apiKeys 显示
            setApiKeys([savedKey]);
            setMessage({ type: "error", text: "连接服务器失败，展示默认/缓存配置" });
        }
      }
    }
  };

  useEffect(() => {
    // 初始化连接地址
    const savedBaseUrl = api.getBaseUrl();
    if (savedBaseUrl) {
      setApiBaseUrl(savedBaseUrl);
    }
    // 加载保存的 API Key
    const savedKey = api.getSavedApiKey();
    if (savedKey) {
      setApiKey(savedKey);
      setTempApiKey(savedKey);
    } else {
      // 没有保存的 API Key，显示初始设置
      setShowInitialSetup(true);
      setLoading(false);
      return;
    }

    fetchStatus();
    fetchConfig();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleInitialSetup = async () => {
    if (!tempApiKey.trim()) {
      setMessage({ type: "error", text: "请输入 API Key" });
      return;
    }
    
    try {
      setSaving(true);      
      api.saveApiKey(tempApiKey);
      setApiKey(tempApiKey);
      
      try {
        let configData = await api.getConfig();
        
        const serverHasKeys = configData.apiKeys && 
                             Array.isArray(configData.apiKeys) && 
                             configData.apiKeys.length > 0 &&
                             configData.apiKeys.some((k: string) => k && k.trim() !== "");

        if (!serverHasKeys) {
            console.log("检测到服务器未初始化，正在应用初始密码...");
            
            const newConfig = {
                ...configData,
                apiKeys: [tempApiKey] // 将用户输入的密码设为第一个 Key
            };
            
            // 执行保存，这会将密码写入 config.yml
            await api.saveConfig(newConfig);
            
            // 更新本地持有的配置对象
            configData = newConfig;
            setMessage({ type: "success", text: "初始化成功：访问密码已保存到服务器。后续请使用此密码登录。" });
        } else {
            setMessage({ type: "success", text: "验证成功：欢迎回来" });
        }

        // 成功获取配置，说明 key 正确
        setConfig(configData);
        if (configData.apiKeys && configData.apiKeys.length > 0) {
          setApiKeys(configData.apiKeys);
        }
        setShowInitialSetup(false);
        setLoading(true);
        fetchStatus();
        const interval = setInterval(fetchStatus, 5000);
      } catch (err: any) {
        console.warn("认证失败或获取配置失败，尝试作为首次初始化处理...");
        
        try {
            const newConfig = {
              server: {
                httpPort: 7860,
                host: "0.0.0.0",
                wsPort: 9998
              },
              apiKeys: [tempApiKey],
              streaming: {
                mode: "real"
              },
              features: {
                forceThinking: false,
                forceWebSearch: false,
                forceUrlContext: false
              },
              accountSwitching: {
                failureThreshold: 3,
                switchOnUses: 40,
                immediateSwitchStatusCodes: [429, 503]
              },
              retry: {
                maxRetries: 1,
                retryDelay: 2000
              },
              concurrency: {
                maxConcurrentRequests: 3
              },
              browser: {
                executablePath: "",
                initialAuthIndex: 1
              }
            };
            
            // 只有当是初始化操作时，我们才尝试覆盖保存配置
            await api.saveConfig(newConfig);
            
            // 重新加载
            setConfig(newConfig);
            setApiKeys([tempApiKey]);
            setShowInitialSetup(false);
            setLoading(true);
            fetchStatus();
            const interval = setInterval(fetchStatus, 5000);
            setMessage({ type: "success", text: "配置已初始化，正在启动..." });
            return; // 初始化成功，结束函数
        } catch (saveErr) {
             console.error("初始化尝试失败:", saveErr);
             api.saveApiKey(""); // 清除无效的 Key
             
             const errorMsg = err.message || "";
             if (errorMsg.includes("未授权") || errorMsg.includes("401")) {
               setMessage({ 
                 type: "error", 
                 text: "验证失败：该 API Key 无效。如果这是现有的服务器，请输入 config.yml 中配置的密钥。" 
               });
             } else {
               setMessage({
                 type: "error",
                 text: `连接失败: ${errorMsg}. 请检查服务器是否运行。`
               });
             }
        }
      }
    } catch (err) {
      setMessage({
        type: "error",
        text: `初始化失败: ${err instanceof Error ? err.message : "未知错误"}`
      });
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (
    action: () => Promise<string>,
    description: string
  ) => {
    try {
      setSaving(true);
      setMessage(null);
      const result = await action();
      setMessage({ type: "success", text: result });
      await fetchStatus();
    } catch (err) {
      setMessage({
        type: "error",
        text: `${description}失败: ${
          err instanceof Error ? err.message : "未知错误"
        }`,
      });
    } finally {
      setSaving(false);
    }
  };

  const handleSetStreamMode = async (mode: "real" | "fake") => {
    await handleToggle(
      () => api.setStreamMode(mode),
      `切换到 ${mode} 模式`
    );
  };

  const handleSaveApiKey = () => {
    api.saveApiKey(apiKey);
    setMessage({ type: "success", text: "API Key 已保存到本地" });
  };

  const handleApplyBaseUrl = () => {
    if (!apiBaseUrl.trim()) {
      setMessage({ type: "error", text: "请输入有效的连接地址" });
      return;
    }
    api.saveBaseUrl(apiBaseUrl.trim());
    setMessage({ type: "success", text: "连接地址已更新，正在重新连接..." });
    fetchConfig();
    fetchStatus();
  };

  const handleSaveConfig = async () => {
    if (!config) return;
    
    try {
      setSaving(true);
      setMessage(null);
      
      // 检查端口或地址是否发生变化，如果变化了，需要更新 frontend 连接地址
      const newBaseUrl = buildBaseUrl(
        config.server?.host,
        config.server?.httpPort
      );
      
      // 过滤空密钥
      const filteredKeys = apiKeys.filter(key => key.trim() !== "");
      
      // 更新配置中的 apiKeys
      const updatedConfig = {
        ...config,
        apiKeys: filteredKeys
      };
      
      // 先发送保存请求（使用当前的 localStorage 中的 Key 进行认证）
      const result = await api.saveConfig(updatedConfig);
      
      // 保存成功后
      // 1. 如果密钥发生了变化，更新 localStorage
      if (filteredKeys.length > 0) {
        api.saveApiKey(filteredKeys[0]);
        setApiKey(filteredKeys[0]); // 更新状态中的 key
      }
      
      // 2. 更新连接地址
      api.saveBaseUrl(newBaseUrl);
      setApiBaseUrl(newBaseUrl);

      setMessage({ type: "success", text: result.message || "配置已保存并重新加载" });
      
      // 重新加载配置和状态
      setTimeout(() => {
        // 由于端口可能变化，这里重新加载可能会失败（如果服务器还在重启中）
        fetchConfig().catch(e => console.log("重连中...", e));
        fetchStatus().catch(e => console.log("重连中...", e));
      }, 2000); // 增加重连等待时间
    } catch (err) {
      setMessage({
        type: "error",
        text: `保存配置失败: ${err instanceof Error ? err.message : "未知错误"}`
      });
    } finally {
      setSaving(false);
    }
  };

  const handleAddApiKey = () => {
    setApiKeys([...apiKeys, ""]);
  };

  const handleRemoveApiKey = (index: number) => {
    if (apiKeys.length > 1) {
      setApiKeys(apiKeys.filter((_, i) => i !== index));
    }
  };

  const handleApiKeyChange = (index: number, value: string) => {
    const newKeys = [...apiKeys];
    newKeys[index] = value;
    setApiKeys(newKeys);
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <RefreshCw className="h-12 w-12 animate-spin text-primary" />
      </div>
    );
  }

  // 显示初始设置界面
  if (showInitialSetup) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="w-full max-w-md rounded-lg border border-border bg-card p-8">
          <h1 className="mb-2 text-2xl font-bold">🎉 欢迎使用</h1>
          <p className="mb-6 text-sm text-muted-foreground">
            首次使用需要设置一个访问密码来保护您的服务
          </p>
          
          {message && (
            <div
              className={cn(
                "mb-4 rounded-lg border p-3",
                message.type === "success"
                  ? "border-green-500 bg-green-50 text-green-900 dark:bg-green-950 dark:text-green-100"
                  : "border-red-500 bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-100"
              )}
            >
              <p className="text-sm">{message.text}</p>
            </div>
          )}
          
          <div className="space-y-4">
            <div>
              <label className="mb-2 block text-sm font-medium">
                设置访问密码 (API Key)
              </label>
              <input
                type="text"
                value={tempApiKey}
                onChange={(e) => setTempApiKey(e.target.value)}
                onKeyPress={(e) => {
                  if (e.key === 'Enter' && !saving) {
                    handleInitialSetup();
                  }
                }}
                placeholder="输入自定义密码"
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
                autoFocus
                disabled={saving}
              />
              <p className="mt-2 text-xs text-muted-foreground">
                💡 这个密码将用于保护您的 API 访问，请妥善保管
              </p>
            </div>
            
            <button
              onClick={handleInitialSetup}
              disabled={saving}
              className="w-full rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {saving ? "初始化中..." : "开始使用"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const isReal = status?.streamingMode.includes("real");
  const hasThinking = status?.forceThinking.includes("✅");
  const hasWebSearch = status?.forceWebSearch.includes("✅");
  const hasUrlContext = status?.forceUrlContext.includes("✅");

  return (
    <div className="p-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold">配置</h1>
        <p className="mt-2 text-muted-foreground">调整代理服务器配置</p>
      </div>

      {/* 消息提示 */}
      {message && (
        <div
          className={cn(
            "mb-6 rounded-lg border p-4",
            message.type === "success"
              ? "border-green-500 bg-green-50 text-green-900 dark:bg-green-950 dark:text-green-100"
              : "border-red-500 bg-red-50 text-red-900 dark:bg-red-950 dark:text-red-100"
          )}
        >
          <p className="text-sm font-medium">{message.text}</p>
        </div>
      )}

      <div className="space-y-6">
        {/* 连接设置 */}
        <div className="rounded-lg border border-border bg-card p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-xl font-semibold">连接设置</h2>
            <Settings className="h-5 w-5 text-muted-foreground" />
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="md:col-span-2">
              <label className="mb-2 block text-sm font-medium">服务地址</label>
              <input
                type="text"
                value={apiBaseUrl}
                onChange={(e) => setApiBaseUrl(e.target.value)}
                placeholder="http://127.0.0.1:7860"
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                修改端口后可在此更新连接地址
              </p>
            </div>
            <div className="flex items-end">
              <button
                onClick={handleApplyBaseUrl}
                className="w-full rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
              >
                应用连接地址
              </button>
            </div>
          </div>
        </div>

        {/* 服务器配置 */}
        <div className="rounded-lg border border-border bg-card p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-xl font-semibold">服务器配置</h2>
            <Settings className="h-5 w-5 text-muted-foreground" />
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            <div>
              <label className="mb-2 block text-sm font-medium">HTTP 端口</label>
              <input
                type="number"
                value={config?.server?.httpPort || 7860}
                onChange={(e) => {
                  if (config) {
                    setConfig({
                      ...config,
                      server: { ...config.server, httpPort: parseInt(e.target.value) }
                    });
                  }
                }}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-2 block text-sm font-medium">监听地址</label>
              <input
                type="text"
                value={config?.server?.host || "0.0.0.0"}
                onChange={(e) => {
                  if (config) {
                    setConfig({
                      ...config,
                      server: { ...config.server, host: e.target.value }
                    });
                  }
                }}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-2 block text-sm font-medium">WebSocket 端口</label>
              <input
                type="number"
                value={config?.server?.wsPort || 9998}
                onChange={(e) => {
                  if (config) {
                    setConfig({
                      ...config,
                      server: { ...config.server, wsPort: parseInt(e.target.value) }
                    });
                  }
                }}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
              />
            </div>
          </div>
        </div>

        {/* API Key 配置 */}
        <div className="rounded-lg border border-border bg-card p-6">
          <h2 className="mb-4 text-xl font-semibold">API 密钥配置</h2>
          <div className="space-y-4">
            <div>
              <label className="mb-2 block text-sm font-medium">API Key 列表</label>
              <div className="space-y-2">
                {apiKeys.map((key, index) => (
                  <div key={index} className="flex gap-2">
                    <input
                      type="password"
                      value={key}
                      onChange={(e) => handleApiKeyChange(index, e.target.value)}
                      placeholder="输入访问密码"
                      className="flex-1 rounded-lg border border-input bg-background px-3 py-2 text-sm"
                    />
                    {apiKeys.length > 1 && (
                      <button
                        onClick={() => handleRemoveApiKey(index)}
                        className="rounded-lg bg-red-500 px-3 py-2 text-sm font-medium text-white hover:bg-red-600"
                      >
                        删除
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <button
                onClick={handleAddApiKey}
                className="mt-2 rounded-lg bg-green-500 px-4 py-2 text-sm font-medium text-white hover:bg-green-600"
              >
                + 添加密钥
              </button>
            </div>
          </div>
        </div>

        {/* 流式传输配置 */}
        <div className="rounded-lg border border-border bg-card p-6">
          <h2 className="mb-4 text-xl font-semibold">流式传输配置</h2>
          <div className="space-y-3">
            <button
              onClick={() => {
                if (config) {
                  setConfig({
                    ...config,
                    streaming: { mode: "real" }
                  });
                }
              }}
              className={cn(
                "w-full rounded-lg border p-4 text-left transition-colors",
                config?.streaming?.mode === "real"
                  ? "border-primary bg-primary/5"
                  : "border-border hover:bg-accent"
              )}
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium">Real 模式 (真实流式)</p>
                  <p className="mt-1 text-sm text-muted-foreground">实时逐块返回数据</p>
                </div>
                {config?.streaming?.mode === "real" && (
                  <div className="h-3 w-3 rounded-full bg-primary" />
                )}
              </div>
            </button>
            <button
              onClick={() => {
                if (config) {
                  setConfig({
                    ...config,
                    streaming: { mode: "fake" }
                  });
                }
              }}
              className={cn(
                "w-full rounded-lg border p-4 text-left transition-colors",
                config?.streaming?.mode === "fake"
                  ? "border-primary bg-primary/5"
                  : "border-border hover:bg-accent"
              )}
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium">Fake 模式 (伪流式)</p>
                  <p className="mt-1 text-sm text-muted-foreground">等待完整响应后一次性返回</p>
                </div>
                {config?.streaming?.mode === "fake" && (
                  <div className="h-3 w-3 rounded-full bg-primary" />
                )}
              </div>
            </button>
          </div>
        </div>

        {/* 功能开关 */}
        <div className="rounded-lg border border-border bg-card p-6">
          <h2 className="mb-4 text-xl font-semibold">功能开关</h2>
          <div className="grid gap-4 md:grid-cols-3">
            <button
              onClick={() => {
                if (config) {
                  setConfig({
                    ...config,
                    features: {
                      ...config.features,
                      forceThinking: !config.features?.forceThinking
                    }
                  });
                }
              }}
              className={cn(
                "rounded-lg border p-4 text-left transition-colors",
                config?.features?.forceThinking
                  ? "border-green-500 bg-green-50 dark:bg-green-950"
                  : "border-border hover:bg-accent"
              )}
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium">强制推理</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {config?.features?.forceThinking ? "已启用" : "已关闭"}
                  </p>
                </div>
                <div
                  className={cn(
                    "relative h-6 w-11 rounded-full transition-colors",
                    config?.features?.forceThinking ? "bg-green-500" : "bg-gray-300"
                  )}
                >
                  <div
                    className={cn(
                      "absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform",
                      config?.features?.forceThinking ? "translate-x-5" : "translate-x-0.5"
                    )}
                  />
                </div>
              </div>
            </button>
            <button
              onClick={() => {
                if (config) {
                  setConfig({
                    ...config,
                    features: {
                      ...config.features,
                      forceWebSearch: !config.features?.forceWebSearch
                    }
                  });
                }
              }}
              className={cn(
                "rounded-lg border p-4 text-left transition-colors",
                config?.features?.forceWebSearch
                  ? "border-green-500 bg-green-50 dark:bg-green-950"
                  : "border-border hover:bg-accent"
              )}
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium">强制联网搜索</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {config?.features?.forceWebSearch ? "已启用" : "已关闭"}
                  </p>
                </div>
                <div
                  className={cn(
                    "relative h-6 w-11 rounded-full transition-colors",
                    config?.features?.forceWebSearch ? "bg-green-500" : "bg-gray-300"
                  )}
                >
                  <div
                    className={cn(
                      "absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform",
                      config?.features?.forceWebSearch ? "translate-x-5" : "translate-x-0.5"
                    )}
                  />
                </div>
              </div>
            </button>
            <button
              onClick={() => {
                if (config) {
                  setConfig({
                    ...config,
                    features: {
                      ...config.features,
                      forceUrlContext: !config.features?.forceUrlContext
                    }
                  });
                }
              }}
              className={cn(
                "rounded-lg border p-4 text-left transition-colors",
                config?.features?.forceUrlContext
                  ? "border-green-500 bg-green-50 dark:bg-green-950"
                  : "border-border hover:bg-accent"
              )}
            >
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium">强制网址上下文</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {config?.features?.forceUrlContext ? "已启用" : "已关闭"}
                  </p>
                </div>
                <div
                  className={cn(
                    "relative h-6 w-11 rounded-full transition-colors",
                    config?.features?.forceUrlContext ? "bg-green-500" : "bg-gray-300"
                  )}
                >
                  <div
                    className={cn(
                      "absolute top-0.5 h-5 w-5 rounded-full bg-white transition-transform",
                      config?.features?.forceUrlContext ? "translate-x-5" : "translate-x-0.5"
                    )}
                  />
                </div>
              </div>
            </button>
          </div>
        </div>

        {/* 账号切换策略 */}
        <div className="rounded-lg border border-border bg-card p-6">
          <h2 className="mb-4 text-xl font-semibold">账号切换策略</h2>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label className="mb-2 block text-sm font-medium">
                失败次数阈值
                <span className="ml-2 text-xs text-muted-foreground">(0=禁用)</span>
              </label>
              <input
                type="number"
                value={config?.accountSwitching?.failureThreshold ?? 3}
                onChange={(e) => {
                  if (config) {
                    setConfig({
                      ...config,
                      accountSwitching: {
                        ...config.accountSwitching,
                        failureThreshold: parseInt(e.target.value)
                      }
                    });
                  }
                }}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
              />
              <p className="mt-1 text-xs text-muted-foreground">连续失败多少次后切换账号</p>
            </div>
            <div>
              <label className="mb-2 block text-sm font-medium">
                使用次数阈值
                <span className="ml-2 text-xs text-muted-foreground">(0=禁用)</span>
              </label>
              <input
                type="number"
                value={config?.accountSwitching?.switchOnUses ?? 40}
                onChange={(e) => {
                  if (config) {
                    setConfig({
                      ...config,
                      accountSwitching: {
                        ...config.accountSwitching,
                        switchOnUses: parseInt(e.target.value)
                      }
                    });
                  }
                }}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
              />
              <p className="mt-1 text-xs text-muted-foreground">使用多少次后自动切换账号</p>
            </div>
            <div className="md:col-span-2">
              <label className="mb-2 block text-sm font-medium">
                立即切换的状态码
                <span className="ml-2 text-xs text-muted-foreground">(逗号分隔，如: 429,503)</span>
              </label>
              <input
                type="text"
                value={config?.accountSwitching?.immediateSwitchStatusCodes?.join(",") || "429,503"}
                onChange={(e) => {
                  if (config) {
                    const codes = e.target.value.split(",").map(c => parseInt(c.trim())).filter(c => !isNaN(c));
                    setConfig({
                      ...config,
                      accountSwitching: {
                        ...config.accountSwitching,
                        immediateSwitchStatusCodes: codes
                      }
                    });
                  }
                }}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
              />
              <p className="mt-1 text-xs text-muted-foreground">遇到这些状态码时立即切换账号</p>
            </div>
          </div>
        </div>

        {/* 重试配置 */}
        <div className="rounded-lg border border-border bg-card p-6">
          <h2 className="mb-4 text-xl font-semibold">重试配置</h2>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label className="mb-2 block text-sm font-medium">最大重试次数</label>
              <input
                type="number"
                value={config?.retry?.maxRetries ?? 1}
                onChange={(e) => {
                  if (config) {
                    setConfig({
                      ...config,
                      retry: {
                        ...config.retry,
                        maxRetries: parseInt(e.target.value)
                      }
                    });
                  }
                }}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-2 block text-sm font-medium">重试间隔 (毫秒)</label>
              <input
                type="number"
                value={config?.retry?.retryDelay ?? 2000}
                onChange={(e) => {
                  if (config) {
                    setConfig({
                      ...config,
                      retry: {
                        ...config.retry,
                        retryDelay: parseInt(e.target.value)
                      }
                    });
                  }
                }}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
              />
            </div>
          </div>
        </div>

        {/* 并发控制 */}
        <div className="rounded-lg border border-border bg-card p-6">
          <h2 className="mb-4 text-xl font-semibold">并发控制</h2>
          <div>
            <label className="mb-2 block text-sm font-medium">
              最大并发请求数
              <span className="ml-2 text-xs text-muted-foreground">(0=不限制)</span>
            </label>
            <input
              type="number"
              value={config?.concurrency?.maxConcurrentRequests ?? 3}
              onChange={(e) => {
                if (config) {
                  setConfig({
                    ...config,
                    concurrency: {
                      ...config.concurrency,
                      maxConcurrentRequests: parseInt(e.target.value)
                    }
                  });
                }
              }}
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
            />
          </div>
        </div>

        {/* 浏览器配置 */}
        <div className="rounded-lg border border-border bg-card p-6">
          <h2 className="mb-4 text-xl font-semibold">浏览器配置</h2>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="md:col-span-2">
              <label className="mb-2 block text-sm font-medium">
                浏览器可执行文件路径
                <span className="ml-2 text-xs text-muted-foreground">(留空则自动检测)</span>
              </label>
              <input
                type="text"
                value={config?.browser?.executablePath || ""}
                onChange={(e) => {
                  if (config) {
                    setConfig({
                      ...config,
                      browser: {
                        ...config.browser,
                        executablePath: e.target.value
                      }
                    });
                  }
                }}
                placeholder="留空自动检测"
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="mb-2 block text-sm font-medium">初始认证索引</label>
              <input
                type="number"
                value={config?.browser?.initialAuthIndex ?? 1}
                onChange={(e) => {
                  if (config) {
                    setConfig({
                      ...config,
                      browser: {
                        ...config.browser,
                        initialAuthIndex: parseInt(e.target.value)
                      }
                    });
                  }
                }}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
              />
              <p className="mt-1 text-xs text-muted-foreground">默认使用第几个账号</p>
            </div>
          </div>
        </div>

        {/* 保存按钮 */}
        <button
          onClick={handleSaveConfig}
          disabled={saving}
          className="w-full flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3 text-base font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          <Save className="h-5 w-5" />
          {saving ? "保存中..." : "保存所有配置"}
        </button>
      </div>
    </div>
  );
}
