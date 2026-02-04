import { useEffect, useState, useRef } from "react";
import { api, StatusResponse } from "@/lib/api";
import { ScrollText, RefreshCw, Download } from "lucide-react";

export default function Logs() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [autoScroll, setAutoScroll] = useState(true);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const logsContainerRef = useRef<HTMLDivElement>(null);

  const fetchStatus = async () => {
    try {
      const data = await api.getStatus();
      setStatus(data);
      setLoading(false);
    } catch (err) {
      console.error("获取状态失败:", err);
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 2000); // 更频繁更新日志
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (autoScroll && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [status?.logs, autoScroll]);

  const handleScroll = () => {
    if (!logsContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } =
      logsContainerRef.current;
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;
    setAutoScroll(isAtBottom);
  };

  const handleDownloadLogs = () => {
    if (!status?.logs) return;
    const blob = new Blob([status.logs], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `aistudio2api-logs-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <RefreshCw className="h-12 w-12 animate-spin text-primary" />
      </div>
    );
  }

  const logs: string[] = status?.logs ? status.logs.split('\n').filter((line: string) => line.trim()) : [];

  return (
    <div className="flex h-full flex-col p-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">日志</h1>
          <p className="mt-2 text-muted-foreground">
            实时查看系统运行日志（最近 {logs.length} 条）
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleDownloadLogs}
            disabled={logs.length === 0}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            <Download className="h-4 w-4" />
            下载日志
          </button>
        </div>
      </div>

      {/* 日志控制 */}
      <div className="mb-4 flex items-center gap-4 rounded-lg border border-border bg-card px-4 py-3">
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300"
          />
          <span className="text-sm font-medium">自动滚动</span>
        </label>
        <div className="ml-auto flex items-center gap-2 text-sm text-muted-foreground">
          <ScrollText className="h-4 w-4" />
          <span>每 2 秒刷新</span>
        </div>
      </div>

      {/* 日志内容 */}
      <div
        ref={logsContainerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto rounded-lg border border-border bg-black p-4 font-mono text-xs"
      >
        {logs.length === 0 ? (
          <div className="flex h-full items-center justify-center text-gray-500">
            <p>暂无日志记录</p>
          </div>
        ) : (
          <div className="space-y-1">
            {logs.map((log: string, index: number) => {
              // 解析日志级别
              let color = "text-gray-300";

              if (log.includes("ERROR") || log.includes("失败")) {
                color = "text-red-400";
              } else if (log.includes("WARN") || log.includes("警告")) {
                color = "text-yellow-400";
              } else if (
                log.includes("SUCCESS") ||
                log.includes("成功") ||
                log.includes("✅")
              ) {
                color = "text-green-400";
              } else if (log.includes("DEBUG")) {
                color = "text-blue-400";
              }

              return (
                <div
                  key={index}
                  className={`${color} hover:bg-white/5 transition-colors`}
                >
                  <span className="select-none text-gray-600">
                    {String(index + 1).padStart(4, "0")}
                  </span>{" "}
                  {log}
                </div>
              );
            })}
            <div ref={logsEndRef} />
          </div>
        )}
      </div>

      {/* 日志统计 */}
      <div className="mt-4 grid grid-cols-4 gap-4 rounded-lg border border-border bg-card p-4">
        <div>
          <p className="text-sm text-muted-foreground">总计</p>
          <p className="mt-1 text-2xl font-bold">{logs.length}</p>
        </div>
        <div>
          <p className="text-sm text-muted-foreground">错误</p>
          <p className="mt-1 text-2xl font-bold text-red-500">
            {logs.filter((l: string) => l.includes("ERROR") || l.includes("失败"))
              .length}
          </p>
        </div>
        <div>
          <p className="text-sm text-muted-foreground">警告</p>
          <p className="mt-1 text-2xl font-bold text-yellow-500">
            {logs.filter((l: string) => l.includes("WARN") || l.includes("警告"))
              .length}
          </p>
        </div>
        <div>
          <p className="text-sm text-muted-foreground">成功</p>
          <p className="mt-1 text-2xl font-bold text-green-500">
            {logs.filter(
              (l: string) =>
                l.includes("SUCCESS") ||
                l.includes("成功") ||
                l.includes("✅")
            ).length}
          </p>
        </div>
      </div>
    </div>
  );
}
