import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import {
  BarChart3,
  RefreshCw,
  TrendingUp,
  Users,
  PieChart as PieChartIcon,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  LineChart,
  Line,
} from "recharts";

interface TrafficLog {
  id: string;
  timestamp: string;
  model: string;
  account: number;
  status: number;
  tokens: number;
  inputTokens?: number;
  outputTokens?: number;
}

const COLORS = [
  "#3b82f6", // blue-500
  "#a855f7", // purple-500
  "#22c55e", // green-500
  "#f97316", // orange-500
  "#ef4444", // red-500
  "#eab308", // yellow-500
  "#06b6d4", // cyan-500
  "#ec4899", // pink-500
];

export default function TokenStats() {
  const [logs, setLogs] = useState<TrafficLog[]>([]);
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchData = async () => {
    try {
      const [traffic, modelList] = await Promise.all([
        api.getTrafficLogs(),
        api.getModels().catch(() => ({ models: [] })),
      ]);
      setLogs(traffic.logs || []);
      setModels(modelList.models || []);
      setLoading(false);
    } catch (err) {
      console.error("获取统计数据失败:", err);
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const stats = useMemo(() => {
    const total = logs.reduce((sum, log) => sum + (log.tokens || 0), 0);
    const input = logs.reduce((sum, log) => sum + (log.inputTokens || 0), 0);
    const output = logs.reduce((sum, log) => sum + (log.outputTokens || 0), 0);
    const accounts = new Set(logs.map((log) => log.account)).size;

    const byModel: Record<
      string,
      { requests: number; input: number; output: number; total: number }
    > = {};
    const allModels = new Set<string>([
      ...models,
      ...logs.map((l) => l.model || "unknown"),
    ]);
    for (const name of allModels) {
      byModel[name] = { requests: 0, input: 0, output: 0, total: 0 };
    }

    const dailyMap: Record<string, any> = {};
    const accountMap: Record<string, number> = {};

    logs.forEach((log) => {
      const name = log.model || "unknown";
      if (!byModel[name]) {
        byModel[name] = { requests: 0, input: 0, output: 0, total: 0 };
      }
      byModel[name].requests += 1;
      byModel[name].input += log.inputTokens || 0;
      byModel[name].output += log.outputTokens || 0;
      byModel[name].total += log.tokens || 0;

      // Daily Stats
      const date = new Date(log.timestamp).toLocaleDateString("en-US", {
        month: "2-digit",
        day: "2-digit",
      });
      if (!dailyMap[date]) dailyMap[date] = { date, total: 0, input: 0, output: 0 };
      dailyMap[date].total += log.tokens || 0;
      dailyMap[date].input += log.inputTokens || 0;
      dailyMap[date].output += log.outputTokens || 0;
      dailyMap[date][name] = (dailyMap[date][name] || 0) + (log.tokens || 0);

      const accId = log.account.toString();
      accountMap[accId] = (accountMap[accId] || 0) + (log.tokens || 0);
    });

    const dailyTrend = Object.values(dailyMap).sort(
      (a: any, b: any) => new Date(a.date).getTime() - new Date(b.date).getTime()
    );

    const accountPie = Object.entries(accountMap)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);

    const activeModels = Object.keys(byModel).filter(
      (m) => byModel[m].total > 0
    );

    return {
      total,
      input,
      output,
      accounts,
      byModel,
      dailyTrend,
      accountPie,
      activeModels,
    };
  }, [logs, models]);

  const formatTokens = (tokens: number) => {
    if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`;
    if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`;
    return tokens.toString();
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <RefreshCw className="h-12 w-12 animate-spin text-primary" />
      </div>
    );
  }

  const modelRows = Object.entries(stats.byModel)
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b.total - a.total);

  return (
    <div className="flex h-full flex-col p-8 overflow-y-auto">
      <div className="mb-6 flex items-center justify-between flex-shrink-0">
        <div>
          <h1 className="text-3xl font-bold">Token 消耗统计</h1>
          <p className="mt-2 text-muted-foreground">
            按模型汇总 Token 使用情况
          </p>
        </div>
        <button
          onClick={fetchData}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          <RefreshCw className="h-4 w-4" />
          刷新数据
        </button>
      </div>

      <div className="mb-6 grid grid-cols-5 gap-4 flex-shrink-0">
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">总 Token</p>
            <TrendingUp className="h-4 w-4 text-purple-500" />
          </div>
          <p className="mt-2 text-2xl font-bold text-purple-500">
            {formatTokens(stats.total)}
          </p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">输入 Token</p>
            <TrendingUp className="h-4 w-4 text-blue-500" />
          </div>
          <p className="mt-2 text-2xl font-bold text-blue-500">
            {formatTokens(stats.input)}
          </p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">输出 Token</p>
            <TrendingUp className="h-4 w-4 text-green-500" />
          </div>
          <p className="mt-2 text-2xl font-bold text-green-500">
            {formatTokens(stats.output)}
          </p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">活跃账号</p>
            <Users className="h-4 w-4 text-emerald-500" />
          </div>
          <p className="mt-2 text-2xl font-bold text-emerald-500">
            {stats.accounts}
          </p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted-foreground">使用模型</p>
            <BarChart3 className="h-4 w-4 text-orange-500" />
          </div>
          <p className="mt-2 text-2xl font-bold text-orange-500">
            {modelRows.filter((m) => m.total > 0).length}
          </p>
        </div>
      </div>

      {/* Chart Section 1: Model Trend */}
      <div className="mb-6 rounded-lg border border-border bg-card p-6">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BarChart3 className="h-5 w-5 text-purple-500" />
            <h2 className="text-lg font-semibold">分模型使用趋势</h2>
          </div>
        </div>
        <div className="h-[300px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={stats.dailyTrend}>
              <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
              <XAxis dataKey="date" />
              <YAxis tickFormatter={formatTokens} />
              <Tooltip
                formatter={(value: any, name: any) => [
                  formatTokens(value || 0),
                  `Model: ${name}`,
                ]}
              />
              <Legend />
              {stats.activeModels.map((model, index) => (
                <Line
                  key={model}
                  type="monotone"
                  dataKey={model}
                  stroke={COLORS[index % COLORS.length]}
                  strokeWidth={2}
                  dot={{ r: 4 }}
                  activeDot={{ r: 6 }}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-6">
        {/* Chart Section 2: Total Token Trend */}
        <div className="rounded-lg border border-border bg-card p-6">
          <div className="mb-4 flex items-center gap-2">
            <TrendingUp className="h-5 w-5 text-blue-500" />
            <h2 className="text-lg font-semibold">Token 使用趋势</h2>
          </div>
          <div className="h-[250px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={stats.dailyTrend}>
                <CartesianGrid strokeDasharray="3 3" opacity={0.3} />
                <XAxis dataKey="date" />
                <YAxis tickFormatter={formatTokens} />
                <Tooltip
                  cursor={{ fill: "rgba(255, 255, 255, 0.05)" }}
                  formatter={(value: any, name: any) => [
                    formatTokens(value || 0),
                    name,
                  ]}
                />
                <Legend />
                <Bar
                  dataKey="input"
                  fill="#3b82f6"
                  name="Input Tokens"
                  radius={[4, 4, 0, 0]}
                  barSize={15}
                />
                <Bar
                  dataKey="output"
                  fill="#22c55e"
                  name="Output Tokens"
                  radius={[4, 4, 0, 0]}
                  barSize={15}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Chart Section 3: Account Stats */}
        <div className="rounded-lg border border-border bg-card p-6">
          <div className="mb-4 flex items-center gap-2">
            <PieChartIcon className="h-5 w-5 text-green-500" />
            <h2 className="text-lg font-semibold">分账号统计</h2>
          </div>
          <div className="h-[250px] w-full flex items-center justify-center">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={stats.accountPie}
                  cx="50%"
                  cy="50%"
                  innerRadius={40}
                  outerRadius={80}
                  paddingAngle={5}
                  dataKey="value"
                >
                  {stats.accountPie.map((_, index) => (
                    <Cell
                      key={`cell-${index}`}
                      fill={COLORS[index % COLORS.length]}
                    />
                  ))}
                </Pie>
                <Tooltip formatter={(value: any) => [formatTokens(value || 0), "Tokens"]} />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card flex-shrink-0">

        <div className="border-b border-border px-6 py-4">
          <h2 className="text-lg font-semibold">分模型详细统计</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/50">
              <tr>
                <th className="px-4 py-3 text-left font-medium">模型</th>
                <th className="px-4 py-3 text-right font-medium">请求数</th>
                <th className="px-4 py-3 text-right font-medium">输入</th>
                <th className="px-4 py-3 text-right font-medium">输出</th>
                <th className="px-4 py-3 text-right font-medium">合计</th>
                <th className="px-4 py-3 text-right font-medium">占比</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {modelRows.map((row) => {
                const share = stats.total > 0 ? (row.total / stats.total) * 100 : 0;
                return (
                  <tr key={row.name}>
                    <td className="px-4 py-3">
                      <span className="font-mono text-xs">{row.name}</span>
                    </td>
                    <td className="px-4 py-3 text-right">{row.requests}</td>
                    <td className="px-4 py-3 text-right text-blue-500">
                      {formatTokens(row.input)}
                    </td>
                    <td className="px-4 py-3 text-right text-green-500">
                      {formatTokens(row.output)}
                    </td>
                    <td className="px-4 py-3 text-right font-medium">
                      {formatTokens(row.total)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <div className="h-2 w-24 rounded-full bg-muted">
                          <div
                            className="h-2 rounded-full bg-primary"
                            style={{ width: `${Math.min(100, share)}%` }}
                          />
                        </div>
                        <span className="text-xs text-muted-foreground">
                          {share.toFixed(1)}%
                        </span>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {modelRows.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-muted-foreground">
                    暂无模型统计数据
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
