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
}

function StatCard({ title, value, icon, trend, status }: StatCardProps) {
  const statusColors = {
    success: "text-green-500",
    warning: "text-yellow-500",
    error: "text-red-500",
  };

  return (
    <div className="rounded-lg border border-border bg-card p-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-muted-foreground">{title}</p>
          <p className="mt-2 text-3xl font-bold">{value}</p>
          {trend && (
            <p className="mt-1 text-sm text-muted-foreground">{trend}</p>
          )}
        </div>
        <div
          className={cn(
            "rounded-full bg-primary/10 p-3",
            status && statusColors[status]
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
    <div className="p-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold">仪表盘</h1>
        <p className="mt-2 text-muted-foreground">实时监控系统运行状态</p>
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
          trend={`总共 ${status.accountDetails.length} 个账号`}
        />
        <StatCard
          title="在途/排队请求"
          value={`${status.activeRequests}/${status.pendingRequests}`}
          icon={<Zap className="h-6 w-6" />}
          trend={`最大并发: ${status.maxConcurrentRequests}`}
        />
        <StatCard
          title="使用/失败计数"
          value={`${currentUsage}/${currentFailure}`}
          icon={<TrendingUp className="h-6 w-6" />}
          status={currentFailure > 0 ? "warning" : "success"}
        />
      </div>

      {/* 详细信息卡片 */}
      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        {/* 服务配置 */}
        <div className="rounded-lg border border-border bg-card p-6">
          <h2 className="mb-4 text-xl font-semibold">服务配置</h2>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">流式模式</span>
              <span className="text-sm font-medium">{status.streamingMode}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">强制推理</span>
              <span className="text-sm font-medium">{status.forceThinking}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">强制联网</span>
              <span className="text-sm font-medium">{status.forceWebSearch}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">强制网址上下文</span>
              <span className="text-sm font-medium">{status.forceUrlContext}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">API 密钥</span>
              <span className="text-sm font-medium">{status.apiKeySource}</span>
            </div>
          </div>
        </div>

        {/* 账号状态 */}
        <div className="rounded-lg border border-border bg-card p-6">
          <h2 className="mb-4 text-xl font-semibold">账号状态</h2>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">使用次数计数</span>
              <span className="text-sm font-medium">{status.usageCount}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">连续失败计数</span>
              <span className="text-sm font-medium">{status.failureCount}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">扫描到的总账号</span>
              <span className="text-sm font-medium">{status.initialIndices}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">格式错误账号</span>
              <span className="text-sm font-medium">{status.invalidIndices}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">立即切换状态码</span>
              <span className="text-sm font-medium">
                {status.immediateSwitchStatusCodes}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* 账号详情列表 */}
      <div className="mt-8 rounded-lg border border-border bg-card p-6">
        <h2 className="mb-4 text-xl font-semibold">账号列表</h2>
        <div className="space-y-2">
          {status.accountDetails.map((account) => (
            <div
              key={account.index}
              className={cn(
                "flex items-center justify-between rounded-lg border p-3",
                account.index === status.currentAuthIndex
                  ? "border-primary bg-primary/5"
                  : "border-border"
              )}
            >
              <div className="flex items-center gap-3">
                {account.index === status.currentAuthIndex ? (
                  <CheckCircle className="h-5 w-5 text-primary" />
                ) : (
                  <Clock className="h-5 w-5 text-muted-foreground" />
                )}
                <span className="font-medium">账号 #{account.index}</span>
              </div>
              <span className="text-sm text-muted-foreground">
                {account.name}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
