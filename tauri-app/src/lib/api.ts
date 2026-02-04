import axios from "axios";

const DEFAULT_API_URL = "http://127.0.0.1:7860";

// 从 localStorage 获取 API URL
const getBaseUrl = () => {
    return localStorage.getItem("apiBaseUrl") || DEFAULT_API_URL;
};

// 保存 API URL 到 localStorage
export const saveBaseUrl = (url: string) => {
    // 确保 URL 没有尾随斜杠
    const cleanUrl = url.replace(/\/$/, "");
    localStorage.setItem("apiBaseUrl", cleanUrl);
    // 更新实例的 default baseURL (虽然后面 interceptor 会覆盖，但这是一个好习惯)
    apiClient.defaults.baseURL = cleanUrl;
};

// 从 localStorage 获取 API Key
const getApiKey = () => {
  return localStorage.getItem("apiKey") || "";
};

// 创建 axios 实例
const apiClient = axios.create({
  baseURL: getBaseUrl(),
  timeout: 30000,
  headers: {
    "Content-Type": "application/json",
  },
});

// 请求拦截器 - 添加 API Key 和动态 Base URL
apiClient.interceptors.request.use((config) => {
  // 每次请求都重新获取 Base URL，确保配置修改后立即生效
  config.baseURL = getBaseUrl();
  
  const apiKey = getApiKey();
  if (apiKey) {
    config.headers["x-api-key"] = apiKey;
  }
  return config;
});

// 响应拦截器 - 检查是否返回了 HTML 登录页面或处理错误
apiClient.interceptors.response.use(
  (response) => {
    // 检查响应是否是 HTML 登录页面（不是普通文本响应）
    const contentType = response.headers["content-type"];
    if (contentType && contentType.includes("text/html")) {
      // 检查是否是登录页面（包含特定的 HTML 标记）
      const data = response.data;
      if (typeof data === 'string' && data.includes('<!DOCTYPE html>') && data.includes('登录')) {
        throw new Error("未授权：请先配置正确的 API Key");
      }
    }
    return response;
  },
  (error) => {
    // 处理错误响应
    if (error.response) {
      const status = error.response.status;
      const contentType = error.response.headers["content-type"];
      
      // 401 未授权错误
      if (status === 401) {
        const errorMsg = error.response.data?.error?.message || "未授权：请先配置正确的 API Key";
        throw new Error(errorMsg);
      }
      
      // HTML 登录页面
      if (contentType && contentType.includes("text/html")) {
        const data = error.response.data;
        if (typeof data === 'string' && data.includes('<!DOCTYPE html>') && data.includes('登录')) {
          throw new Error("未授权：请先配置正确的 API Key");
        }
      }
      
      // 其他错误：尝试提取错误消息
      const message = error.response.data?.error?.message || 
                     error.response.data?.error || 
                     error.response.data?.message ||
                     error.response.statusText ||
                     "请求失败";
      throw new Error(message);
    }
    
    // 网络错误或其他错误
    if (error.message) {
      throw error;
    }
    throw new Error("网络请求失败");
  }
);

export interface SystemStatus {
  streamingMode: string;
  maxConcurrentRequests: number;
  activeRequests: number;
  pendingRequests: number;
  forceThinking: string;
  forceWebSearch: string;
  forceUrlContext: string;
  browserConnected: boolean;
  immediateSwitchStatusCodes: string;
  apiKeySource: string;
  currentAuthIndex: number;
  usageCount: string;
  failureCount: string;
  initialIndices: string;
  accountDetails: Array<{ index: number; name: string }>;
  invalidIndices: string;
}

export interface StatusResponse {
  status: SystemStatus;
  logs: string;
  logCount: number;
}

export const api = {
  // 获取系统状态
  getStatus: async (): Promise<StatusResponse> => {
    const response = await apiClient.get("/api/status");
    return response.data;
  },

  // 切换账号
  switchAccount: async (targetIndex?: number): Promise<string> => {
    const response = await apiClient.post("/api/switch-account", {
      targetIndex,
    });
    return response.data;
  },

  // 设置流式模式
  setStreamMode: async (mode: "real" | "fake"): Promise<string> => {
    const response = await apiClient.post("/api/set-mode", { mode });
    return response.data;
  },

  // 切换强制推理
  toggleForceThinking: async (): Promise<string> => {
    const response = await apiClient.post("/api/toggle-force-thinking");
    return response.data;
  },

  // 切换强制联网
  toggleForceWebSearch: async (): Promise<string> => {
    const response = await apiClient.post("/api/toggle-force-web-search");
    return response.data;
  },

  // 切换强制网址上下文
  toggleForceUrlContext: async (): Promise<string> => {
    const response = await apiClient.post("/api/toggle-force-url-context");
    return response.data;
  },

  // 上传认证文件
  uploadAuth: async (data: {
    storageState: object | string;
    accountName?: string;
    targetIndex?: number;
  }): Promise<{ success: boolean; index: number; file: string; mode: string }> => {
    const response = await apiClient.post("/api/upload-auth", data);
    return response.data;
  },

  // 保存 API Key
  saveApiKey: (apiKey: string) => {
    localStorage.setItem("apiKey", apiKey);
  },

  // 获取保存的 API Key
  getSavedApiKey: () => {
    return localStorage.getItem("apiKey") || "";
  },

  // 获取流量日志
  getTrafficLogs: async (): Promise<{
    logs: Array<{
      id: string;
      timestamp: string;
      method: string;
      path: string;
      model: string;
      protocol: string;
      account: number;
      status: number;
      statusText: string;
      tokens: number;
      duration: number;
      inputTokens?: number;
      outputTokens?: number;
    }>;
    stats: {
      totalRequests: number;
      successRequests: number;
      errorRequests: number;
      totalTokens: number;
      avgDuration: number;
    };
  }> => {
    const response = await apiClient.get("/api/traffic");
    return response.data;
  },

  // 获取模型列表
  getModels: async (): Promise<{ models: string[] }> => {
    const response = await apiClient.get("/api/models");
    return response.data;
  },

  // 获取配置文件
  getConfig: async (): Promise<any> => {
    const response = await apiClient.get("/api/config");
    return response.data;
  },

  // 保存配置文件
  saveConfig: async (config: any): Promise<{ success: boolean; message: string }> => {
    const response = await apiClient.post("/api/config", config);
    return response.data;
  },

  // 暴露保存 Base URL 的方法
  saveBaseUrl,
  getBaseUrl,
};

export default api;
