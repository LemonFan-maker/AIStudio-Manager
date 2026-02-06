import { useEffect, useState } from "react";
import { api, SystemStatus } from "@/lib/api";
import {
  Activity,
  Users,
  Zap,
  AlertCircle,
  CheckCircle,
  Clock,
  TrendingUp,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface StatCardProps {
  title: string;
  value: string | number;
  icon: React.ReactNode;
  trend?: string;
  status?: "success" | "warning" | "error";
  delay?: number;
}

function StatCard({ title, value, icon, trend, status, delay = 0 }: StatCardProps) {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setIsVisible(true), delay);
    return () => clearTimeout(timer);
  }, [delay]);

  const statusConfig = {
    success: {
      iconBg: "bg-gradient-to-br from-emerald-500/20 to-emerald-600/10",
      iconColor: "text-emerald-500",
      glow: "shadow-emerald-500/10",
    },
    warning: {
      iconBg: "bg-gradient-to-br from-amber-500/20 to-amber-600/10",
      iconColor: "text-amber-500",
      glow: "shadow-amber-500/10",
    },
    error: {
      iconBg: "bg-gradient-to-br from-rose-500/20 to-rose-600/10",
      iconColor: "text-rose-500",
      glow: "shadow-rose-500/10",
    },
    default: {
      iconBg: "bg-gradient-to-br from-blue-500/20 to-blue-600/10",
      iconColor: "text-blue-500",
      glow: "shadow-blue-500/10",
    },
  };

  const config = status ? statusConfig[status] : statusConfig.default;

  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-xl border border-border/50 bg-card p-6 shadow-sm",
        "transition-all duration-300 ease-out",
        "hover:shadow-lg hover:border-border hover:-translate-y-0.5",
        config.glow,
        isVisible ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"
      )}
      style={{ transitionDelay: `${delay}ms` }}
    >
      {/* 背景装饰 */}
      <div className="absolute -right-8 -top-8 h-24 w-24 rounded-full bg-gradient-to-br from-primary/5 to-transparent blur-2xl transition-opacity group-hover:opacity-70" />

      <div className="relative flex items-center justify-between">
        <div className="space-y-1">
          <p className="text-sm font-medium text-muted-foreground">{title}</p>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold tracking-tight tabular-nums">{value}</span>
          </div>
          {trend && (
            <p className="text-xs text-muted-foreground">{trend}</p>
          )}
        </div>
        <div
          className={cn(
            "rounded-xl p-3 transition-all duration-300",
            "group-hover:scale-110 group-hover:rotate-3",
            config.iconBg, config.iconColor
          )}
        >
          {icon}
        </div>
      </div>
    </div>
  );
}


export default function Dashboard() {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchStatus = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await api.getStatus();
      setStatus(data.status);
    } catch (err) {
      setError(err instanceof Error ? err.message : "获取状态失败");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  if (loading && !status) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <Activity className="mx-auto h-12 w-12 animate-spin text-primary" />
          <p className="mt-4 text-sm text-muted-foreground">加载中...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <AlertCircle className="mx-auto h-12 w-12 text-destructive" />
          <p className="mt-4 text-sm text-muted-foreground">{error}</p>
          <button
            onClick={fetchStatus}
            className="mt-4 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            重试
          </button>
        </div>
      </div>
    );
  }

  if (!status) return null;

  const usageMatch = status.usageCount.match(/(\d+)\s*\/\s*(\d+|N\/A)/);
  const failureMatch = status.failureCount.match(/(\d+)\s*\/\s*(\d+|N\/A)/);
  const currentUsage = usageMatch ? parseInt(usageMatch[1]) : 0;
  const currentFailure = failureMatch ? parseInt(failureMatch[1]) : 0;

  return (
    <div className="space-y-6 p-8 max-w-[1600px] mx-auto animate-in fade-in duration-500">
      <div className="flex items-end justify-between border-b border-border/40 pb-6">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">仪表盘</h1>
          <p className="mt-2 text-muted-foreground">实时监控系统运行状态与核心指标</p>
        </div>
        <div className="hidden sm:block text-xs text-muted-foreground bg-muted/50 px-3 py-1 rounded-full">
          系统状态概览
        </div>
      </div>

      {/* 状态卡片网格 */}
      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="浏览器连接"
          value={status.browserConnected ? "已连接" : "断开"}
          icon={<Activity className="h-6 w-6" />}
          status={status.browserConnected ? "success" : "error"}
        />
        <StatCard
          title="当前账号"
          value={`#${status.currentAuthIndex}`}
          icon={<Users className="h-6 w-6" />}
          trend={`账号池总数: ${status.accountDetails.length}`}
        />
        <StatCard
          title="在途/排队请求"
          value={`${status.activeRequests} / ${status.pendingRequests}`}
          icon={<Zap className="h-6 w-6" />}
          trend={`最大并发: ${status.maxConcurrentRequests}`}
        />
        <StatCard
          title="每日使用/失败"
          value={`${currentUsage} / ${currentFailure}`}
          icon={<TrendingUp className="h-6 w-6" />}
          status={currentFailure > 0 ? "warning" : "success"}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* 服务配置 */}
        <div className="overflow-hidden rounded-xl border border-border/50 bg-card shadow-sm transition-all hover:shadow-md">
          <div className="border-b border-border/50 bg-muted/30 p-5">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <span className="h-4 w-1 bg-primary rounded-full"></span>
              服务配置
            </h2>
          </div>
          <div className="divide-y divide-border/50">
            {[
              { label: "流式模式", value: status.streamingMode },
              { label: "强制推理", value: status.forceThinking },
              { label: "强制联网", value: status.forceWebSearch },
              { label: "强制网址上下文", value: status.forceUrlContext },
              { label: "API 密钥", value: status.apiKeySource, highlight: true }
            ].map((item, i) => (
              <div key={i} className="grid grid-cols-2 p-4 hover:bg-muted/50 transition-colors items-center">
                <span className="text-sm font-medium text-muted-foreground">{item.label}</span>
                <span className={cn(
                  "text-sm font-medium text-right",
                  item.highlight && "bg-primary/10 text-primary px-2 py-0.5 rounded w-fit justify-self-end font-mono"
                )}>{item.value}</span>
              </div>
            ))}
          </div>
        </div>

        {/* 账号状态 */}
        <div className="overflow-hidden rounded-xl border border-border/50 bg-card shadow-sm transition-all hover:shadow-md">
          <div className="border-b border-border/50 bg-muted/30 p-5">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <span className="h-4 w-1 bg-indigo-500 rounded-full"></span>
              运行指标
            </h2>
          </div>
          <div className="divide-y divide-border/50">
            <div className="grid grid-cols-2 p-4 hover:bg-muted/50 transition-colors items-center">
              <span className="text-sm font-medium text-muted-foreground">使用次数计数</span>
              <span className="text-sm font-medium text-right font-mono">{status.usageCount}</span>
            </div>
            <div className="grid grid-cols-2 p-4 hover:bg-muted/50 transition-colors items-center">
              <span className="text-sm font-medium text-muted-foreground">连续失败计数</span>
              <span className="text-sm font-medium text-right font-mono">{status.failureCount}</span>
            </div>
            <div className="grid grid-cols-2 p-4 hover:bg-muted/50 transition-colors items-center">
              <span className="text-sm font-medium text-muted-foreground">扫描到的总账号</span>
              <span className="text-sm font-medium text-right">{status.initialIndices}</span>
            </div>
            <div className="grid grid-cols-2 p-4 hover:bg-muted/50 transition-colors items-center">
              <span className="text-sm font-medium text-muted-foreground">格式错误账号</span>
              <span className="text-sm font-medium text-right">{status.invalidIndices}</span>
            </div>
            <div className="flex flex-col p-4 gap-2 hover:bg-muted/50 transition-colors">
              <span className="text-sm font-medium text-muted-foreground">立即切换状态码</span>
              <div className="flex flex-wrap gap-1 mt-1">
                {status.immediateSwitchStatusCodes?.replace(/[\[\]]/g, '').split(',').filter((x: string) => x.trim()).map((code: string) => (
                  <span key={code} className="inline-flex items-center rounded-md bg-secondary px-2 py-1 text-xs font-medium text-secondary-foreground ring-1 ring-inset ring-border">
                    {code.trim()}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 账号详情列表 */}
      <div className="overflow-hidden rounded-xl border border-border/50 bg-card shadow-sm transition-all hover:shadow-md">
        <div className="border-b border-border/50 bg-muted/30 p-5">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <span className="h-4 w-1 bg-emerald-500 rounded-full"></span>
            账号列表详情
          </h2>
        </div>
        <div className="p-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {status.accountDetails.map((account) => (
              <div
                key={account.index}
                className={cn(
                  "group relative flex items-center space-x-3 rounded-xl border p-4 shadow-sm transition-all hover:shadow-md",
                  account.index === status.currentAuthIndex
                    ? "border-primary/50 bg-primary/5 ring-1 ring-primary/20"
                    : "border-border/60 bg-card hover:border-primary/30 hover:bg-accent/5"
                )}
              >
                <div className="flex-shrink-0">
                  {account.index === status.currentAuthIndex ? (
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary shadow-inner">
                      <CheckCircle className="h-5 w-5" />
                    </div>
                  ) : (
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground group-hover:bg-primary/10 group-hover:text-primary transition-colors">
                      <Clock className="h-5 w-5" />
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="focus:outline-none">
                    <span className="absolute inset-0" aria-hidden="true" />
                    <p className="text-sm font-semibold text-foreground">
                      账号 #{account.index}
                    </p>
                    <p className="truncate text-xs text-muted-foreground mt-0.5" title={account.name}>
                      {account.name}
                    </p>
                  </div>
                </div>
                {account.index === status.currentAuthIndex && (
                  <span className="absolute top-2 right-2 flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-primary"></span>
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
