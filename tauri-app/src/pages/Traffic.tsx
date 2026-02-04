import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { RefreshCw, TrendingUp, Clock, AlertCircle, CheckCircle2, X } from "lucide-react";

interface TrafficLog {
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
  inputTokens?: number;
  outputTokens?: number;
  duration: number;
  requestBody?: string;
  responseBody?: string;
}

interface TrafficStats {
  totalRequests: number;
  successRequests: number;
  errorRequests: number;
  totalTokens: number;
  avgDuration: number;
}

export default function Traffic() {
  const [logs, setLogs] = useState<TrafficLog[]>([]);
  const [stats, setStats] = useState<TrafficStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedLog, setSelectedLog] = useState<TrafficLog | null>(null);

  const fetchTrafficData = async () => {
    try {
      const data = await api.getTrafficLogs();
      setLogs(data.logs || []);
      setStats(data.stats || null);
      setLoading(false);
    } catch (err) {
      console.error("获取流量数据失败:", err);
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTrafficData();
  }, []);

  const getStatusBadge = (status: number) => {
    if (status >= 200 && status < 300) {
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-1 text-xs font-medium text-green-500">
          <CheckCircle2 className="h-3 w-3" />
          {status}
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-1 text-xs font-medium text-red-500">
        <AlertCircle className="h-3 w-3" />
        {status}
      </span>
    );
  };

  const getMethodBadge = (method: string) => {
    const colors: Record<string, string> = {
      GET: "bg-blue-500/10 text-blue-500",
      POST: "bg-green-500/10 text-green-500",
      PUT: "bg-yellow-500/10 text-yellow-500",
      DELETE: "bg-red-500/10 text-red-500",
    };
    const color = colors[method] || "bg-gray-500/10 text-gray-500";
    return (
      <span className={`rounded px-2 py-1 text-xs font-medium ${color}`}>
        {method}
      </span>
    );
  };

  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;
    return `${(ms / 1000).toFixed(2)}s`;
  };

  const formatTokens = (tokens: number) => {
    if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`;
    return tokens.toString();
  };

  const safeJsonStringify = (value: string) => {
    try {
      const parsed = JSON.parse(value);
      return JSON.stringify(parsed, null, 2);
    } catch (e) {
      return value;
    }
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <RefreshCw className="h-12 w-12 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col p-8">
      {/* 头部 */}
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">流量统计</h1>
          <p className="mt-2 text-muted-foreground">
            实时监控 API 请求流量和性能指标
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={fetchTrafficData}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            <RefreshCw className="h-4 w-4" />
            刷新数据
          </button>
        </div>
      </div>

      {/* 统计卡片 */}
      {stats && (
        <div className="mb-6 grid grid-cols-5 gap-4">
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">总请求</p>
              <TrendingUp className="h-4 w-4 text-blue-500" />
            </div>
            <p className="mt-2 text-2xl font-bold">{stats.totalRequests}</p>
          </div>
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">成功</p>
              <CheckCircle2 className="h-4 w-4 text-green-500" />
            </div>
            <p className="mt-2 text-2xl font-bold text-green-500">
              {stats.successRequests}
            </p>
          </div>
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">错误</p>
              <AlertCircle className="h-4 w-4 text-red-500" />
            </div>
            <p className="mt-2 text-2xl font-bold text-red-500">
              {stats.errorRequests}
            </p>
          </div>
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">Token 消耗</p>
              <TrendingUp className="h-4 w-4 text-purple-500" />
            </div>
            <p className="mt-2 text-2xl font-bold text-purple-500">
              {formatTokens(stats.totalTokens)}
            </p>
          </div>
          <div className="rounded-lg border border-border bg-card p-4">
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">平均耗时</p>
              <Clock className="h-4 w-4 text-orange-500" />
            </div>
            <p className="mt-2 text-2xl font-bold text-orange-500">
              {formatDuration(stats.avgDuration)}
            </p>
          </div>
        </div>
      )}

      {/* 请求日志表格 */}
      <div className="flex-1 overflow-hidden rounded-lg border border-border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/50">
              <tr>
                <th className="px-4 py-3 text-left font-medium">状态</th>
                <th className="px-4 py-3 text-left font-medium">方法</th>
                <th className="px-4 py-3 text-left font-medium">模型</th>
                <th className="px-4 py-3 text-left font-medium">协议</th>
                <th className="px-4 py-3 text-left font-medium">账号</th>
                <th className="px-4 py-3 text-left font-medium">路径</th>
                <th className="px-4 py-3 text-right font-medium">Token 消耗</th>
                <th className="px-4 py-3 text-right font-medium">耗时</th>
                <th className="px-4 py-3 text-left font-medium">时间</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {logs.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center text-muted-foreground">
                    暂无请求记录
                  </td>
                </tr>
              ) : (
                logs.map((log) => (
                  <tr 
                    key={log.id} 
                    className="hover:bg-muted/50 transition-colors cursor-pointer"
                    onClick={() => setSelectedLog(log)}
                  >
                    <td className="px-4 py-3">{getStatusBadge(log.status)}</td>
                    <td className="px-4 py-3">{getMethodBadge(log.method)}</td>
                    <td className="px-4 py-3">
                      <span className="font-mono text-xs">{log.model}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="rounded bg-muted px-2 py-1 text-xs">
                        {log.protocol}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-medium">#{log.account}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-mono text-xs text-muted-foreground">
                        {log.path.length > 40
                          ? log.path.substring(0, 40) + "..."
                          : log.path}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-mono">
                      {formatTokens(log.tokens)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono">
                      {formatDuration(log.duration)}
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-xs text-muted-foreground">
                        {new Date(log.timestamp).toLocaleString("zh-CN", {
                          month: "2-digit",
                          day: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit",
                        })}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* 详情弹窗 */}
      {selectedLog && (
        <div 
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setSelectedLog(null)}
        >
          <div 
            className="relative w-full max-w-4xl max-h-[90vh] overflow-auto rounded-lg border border-border bg-card shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            {/* 头部 */}
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-card px-6 py-4">
              <div className="flex items-center gap-3">
                {getStatusBadge(selectedLog.status)}
                {getMethodBadge(selectedLog.method)}
                <span className="font-mono text-sm">{selectedLog.path}</span>
              </div>
              <button
                onClick={() => setSelectedLog(null)}
                className="rounded-lg p-2 hover:bg-muted transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* 内容 */}
            <div className="p-6 space-y-6">
              {/* 基本信息 */}
              <div>
                <h3 className="text-sm font-semibold text-muted-foreground mb-3">请求时间</h3>
                <div className="text-base">
                  {new Date(selectedLog.timestamp).toLocaleString("zh-CN", {
                    year: "numeric",
                    month: "2-digit",
                    day: "2-digit",
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}
                </div>
              </div>

              <div>
                <h3 className="text-sm font-semibold text-muted-foreground mb-3">耗时</h3>
                <div className="text-base">{formatDuration(selectedLog.duration)}</div>
              </div>

              <div>
                <h3 className="text-sm font-semibold text-muted-foreground mb-3">使用模型</h3>
                <div className="rounded-lg bg-muted p-3 font-mono text-sm">
                  {selectedLog.model}
                </div>
              </div>

              {/* Token 消耗 */}
              <div>
                <h3 className="text-sm font-semibold text-muted-foreground mb-3">
                  TOKEN 消耗（输入/输出）
                </h3>
                <div className="flex items-center gap-6">
                  <div className="rounded-lg bg-blue-500/10 px-4 py-2">
                    <span className="text-xs text-muted-foreground">In:</span>
                    <span className="ml-2 font-mono text-sm text-blue-500">
                      {selectedLog.inputTokens || 0}
                    </span>
                  </div>
                  <div className="rounded-lg bg-green-500/10 px-4 py-2">
                    <span className="text-xs text-muted-foreground">Out:</span>
                    <span className="ml-2 font-mono text-sm text-green-500">
                      {selectedLog.outputTokens || 0}
                    </span>
                  </div>
                </div>
              </div>

              {/* 请求格式 */}
              {selectedLog.requestBody && (
                <div>
                  <h3 className="text-sm font-semibold text-muted-foreground mb-3">
                    请求格式 (REQUEST)
                  </h3>
                  <div className="rounded-lg bg-black p-4 overflow-x-auto">
                    <pre className="text-xs text-gray-300 font-mono whitespace-pre-wrap">
                      {safeJsonStringify(selectedLog.requestBody)}
                    </pre>
                  </div>
                </div>
              )}

              {/* 响应格式 */}
              {selectedLog.responseBody && (
                <div>
                  <h3 className="text-sm font-semibold text-muted-foreground mb-3">
                    响应格式 (RESPONSE)
                  </h3>
                  <div className="rounded-lg bg-black p-4 overflow-x-auto">
                    <pre className="text-xs text-gray-300 font-mono whitespace-pre-wrap">
                      {safeJsonStringify(selectedLog.responseBody)}
                    </pre>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
