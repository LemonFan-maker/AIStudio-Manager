import { useEffect, useState, useRef, useMemo } from "react";
import { api, StatusResponse } from "@/lib/api";
import { ScrollText, RefreshCw, Download, Search, Filter, X } from "lucide-react";
import { cn } from "@/lib/utils";

type LogLevel = "all" | "info" | "warn" | "error" | "success";

const LOG_LEVEL_CONFIG: Record<LogLevel, { label: string; color: string; bgColor: string }> = {
  all: { label: "全部", color: "text-foreground", bgColor: "bg-muted" },
  info: { label: "信息", color: "text-blue-400", bgColor: "bg-blue-500/10" },
  warn: { label: "警告", color: "text-yellow-400", bgColor: "bg-yellow-500/10" },
  error: { label: "错误", color: "text-red-400", bgColor: "bg-red-500/10" },
  success: { label: "成功", color: "text-green-400", bgColor: "bg-green-500/10" },
};

export default function Logs() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [autoScroll, setAutoScroll] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [levelFilter, setLevelFilter] = useState<LogLevel>("all");
  const [showFilters, setShowFilters] = useState(false);
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
    const interval = setInterval(fetchStatus, 2000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (autoScroll && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [status?.logs, autoScroll]);

  const handleScroll = () => {
    if (!logsContainerRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = logsContainerRef.current;
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

  const getLogLevel = (log: string): LogLevel => {
    if (log.includes("ERROR") || log.includes("失败")) return "error";
    if (log.includes("WARN") || log.includes("警告")) return "warn";
    if (log.includes("SUCCESS") || log.includes("成功") || log.includes("✅")) return "success";
    return "info";
  };

  const getLogColor = (level: LogLevel): string => {
    return LOG_LEVEL_CONFIG[level].color;
  };

  // 解析和过滤日志
  const { filteredLogs, logStats } = useMemo(() => {
    const allLogs: string[] = status?.logs
      ? status.logs.split("\n").filter((line: string) => line.trim())
      : [];

    const stats = {
      total: allLogs.length,
      info: 0,
      warn: 0,
      error: 0,
      success: 0,
    };

    const filtered = allLogs.filter((log) => {
      const level = getLogLevel(log);
      if (level !== "all" && level in stats) {
        stats[level as keyof typeof stats]++;
      }

      // 级别过滤
      if (levelFilter !== "all" && level !== levelFilter) return false;

      // 搜索过滤
      if (searchQuery && !log.toLowerCase().includes(searchQuery.toLowerCase())) {
        return false;
      }

      return true;
    });

    return { filteredLogs: filtered, logStats: stats };
  }, [status?.logs, levelFilter, searchQuery]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <RefreshCw className="h-12 w-12 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col p-8 animate-page-in">
      {/* 头部 */}
      <div className="mb-6 flex items-center justify-between flex-shrink-0">
        <div>
          <h1 className="text-3xl font-bold">日志</h1>
          <p className="mt-2 text-muted-foreground">
            实时查看系统运行日志（共 {logStats.total} 条，显示 {filteredLogs.length} 条）
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowFilters(!showFilters)}
            className={cn(
              "flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-colors",
              showFilters
                ? "border-primary bg-primary/10 text-primary"
                : "border-border hover:bg-accent"
            )}
          >
            <Filter className="h-4 w-4" />
            过滤
          </button>
          <button
            onClick={handleDownloadLogs}
            disabled={filteredLogs.length === 0}
            className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            <Download className="h-4 w-4" />
            下载日志
          </button>
        </div>
      </div>

      {/* 过滤器面板 */}
      {showFilters && (
        <div className="mb-4 rounded-lg border border-border bg-card p-4 animate-in slide-in-from-top-2 duration-200">
          <div className="flex flex-wrap items-center gap-4">
            {/* 搜索框 */}
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索日志内容..."
                className="w-full rounded-lg border border-input bg-background pl-10 pr-10 py-2 text-sm"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery("")}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>

            {/* 级别过滤 */}
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">级别：</span>
              <div className="flex gap-1">
                {(Object.keys(LOG_LEVEL_CONFIG) as LogLevel[]).map((level) => (
                  <button
                    key={level}
                    onClick={() => setLevelFilter(level)}
                    className={cn(
                      "rounded-lg px-3 py-1.5 text-xs font-medium transition-colors",
                      levelFilter === level
                        ? "bg-primary text-primary-foreground"
                        : "bg-muted text-muted-foreground hover:bg-accent"
                    )}
                  >
                    {LOG_LEVEL_CONFIG[level].label}
                    {level !== "all" && (
                      <span className="ml-1 opacity-70">
                        ({logStats[level as keyof typeof logStats]})
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 日志控制 */}
      <div className="mb-4 flex items-center gap-4 rounded-lg border border-border bg-card px-4 py-3 flex-shrink-0">
        <label className="flex cursor-pointer items-center gap-2">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
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
        {filteredLogs.length === 0 ? (
          <div className="flex h-full items-center justify-center text-gray-500">
            <div className="text-center">
              <ScrollText className="mx-auto h-12 w-12 opacity-30 mb-3" />
              <p>{searchQuery || levelFilter !== "all" ? "没有匹配的日志" : "暂无日志记录"}</p>
            </div>
          </div>
        ) : (
          <div className="space-y-0.5">
            {filteredLogs.map((log: string, index: number) => {
              const level = getLogLevel(log);
              const color = getLogColor(level);

              return (
                <div
                  key={index}
                  className={`${color} hover:bg-white/5 transition-colors py-0.5 px-1 rounded`}
                >
                  <span className="select-none text-gray-600 mr-2">
                    {String(index + 1).padStart(4, "0")}
                  </span>
                  {log}
                </div>
              );
            })}
            <div ref={logsEndRef} />
          </div>
        )}
      </div>

      {/* 日志统计 */}
      <div className="mt-4 grid grid-cols-5 gap-4 rounded-lg border border-border bg-card p-4 flex-shrink-0">
        <div>
          <p className="text-sm text-muted-foreground">总计</p>
          <p className="mt-1 text-2xl font-bold">{logStats.total}</p>
        </div>
        <div>
          <p className="text-sm text-muted-foreground">信息</p>
          <p className="mt-1 text-2xl font-bold text-blue-500">{logStats.info}</p>
        </div>
        <div>
          <p className="text-sm text-muted-foreground">成功</p>
          <p className="mt-1 text-2xl font-bold text-green-500">{logStats.success}</p>
        </div>
        <div>
          <p className="text-sm text-muted-foreground">警告</p>
          <p className="mt-1 text-2xl font-bold text-yellow-500">{logStats.warn}</p>
        </div>
        <div>
          <p className="text-sm text-muted-foreground">错误</p>
          <p className="mt-1 text-2xl font-bold text-red-500">{logStats.error}</p>
        </div>
      </div>
    </div>
  );
}
