import { useState, useEffect } from "react";
import { Outlet, NavLink } from "react-router-dom";
import {
  LayoutDashboard,
  Users,
  Settings,
  ScrollText,
  Activity,
  BarChart3,
  PieChart,
  ChevronLeft,
  ChevronRight,
  Wifi,
  WifiOff,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";

const navItems = [
  { path: "/dashboard", icon: LayoutDashboard, label: "仪表盘" },
  { path: "/accounts", icon: Users, label: "账号管理" },
  { path: "/traffic", icon: BarChart3, label: "流量统计" },
  { path: "/token-stats", icon: PieChart, label: "Token 统计" },
  { path: "/logs", icon: ScrollText, label: "日志" },
  { path: "/config", icon: Settings, label: "配置" },
];

export default function Layout() {
  const [collapsed, setCollapsed] = useState(false);
  const [isConnected, setIsConnected] = useState(false);

  // 检查服务器连接状态
  useEffect(() => {
    const checkConnection = async () => {
      try {
        await api.getStatus();
        setIsConnected(true);
      } catch {
        setIsConnected(false);
      }
    };

    checkConnection();
    const interval = setInterval(checkConnection, 10000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex h-screen bg-slate-50 dark:bg-background">
      {/* 侧边栏 */}
      <aside
        className={cn(
          "relative border-r border-border bg-card transition-all duration-300 ease-in-out flex flex-col",
          collapsed ? "w-16" : "w-64"
        )}
      >
        {/* Logo 区域 */}
        <div className={cn(
          "flex h-16 items-center border-b border-border px-4 transition-all",
          collapsed ? "justify-center" : "gap-3"
        )}>
          <div className="relative">
            <Activity className="h-7 w-7 text-primary" />
            {/* 连接状态指示器 */}
            <span
              className={cn(
                "absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-card",
                isConnected ? "bg-emerald-500" : "bg-red-500"
              )}
            />
          </div>
          {!collapsed && (
            <div className="flex flex-col">
              <h1 className="text-lg font-bold leading-none">AIStudio</h1>
              <span className="text-[10px] text-muted-foreground">Manager</span>
            </div>
          )}
        </div>

        {/* 导航区域 */}
        <nav className="flex-1 space-y-1 p-3 overflow-y-auto">
          {navItems.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              className={({ isActive }) =>
                cn(
                  "flex items-center rounded-lg px-3 py-2.5 text-sm font-medium transition-all duration-200",
                  collapsed ? "justify-center" : "gap-3",
                  isActive
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                )
              }
              title={collapsed ? item.label : undefined}
            >
              <item.icon className={cn("h-5 w-5 flex-shrink-0", collapsed && "h-5 w-5")} />
              {!collapsed && <span className="truncate">{item.label}</span>}
            </NavLink>
          ))}
        </nav>

        {/* 底部状态区域 */}
        <div className="border-t border-border p-3">
          {/* 连接状态 */}
          <div className={cn(
            "flex items-center rounded-lg bg-muted/50 px-3 py-2 mb-2",
            collapsed ? "justify-center" : "gap-2"
          )}>
            {isConnected ? (
              <Wifi className="h-4 w-4 text-emerald-500" />
            ) : (
              <WifiOff className="h-4 w-4 text-red-500" />
            )}
            {!collapsed && (
              <span className={cn(
                "text-xs font-medium",
                isConnected ? "text-emerald-500" : "text-red-500"
              )}>
                {isConnected ? "已连接" : "未连接"}
              </span>
            )}
          </div>

          {/* 版本信息 */}
          {!collapsed && (
            <div className="text-center text-[10px] text-muted-foreground">
              v1.0.0 • AIStudio2API
            </div>
          )}
        </div>

        {/* 折叠按钮 */}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className="absolute -right-3 top-20 flex h-6 w-6 items-center justify-center rounded-full border border-border bg-card shadow-sm hover:bg-accent transition-colors"
        >
          {collapsed ? (
            <ChevronRight className="h-3.5 w-3.5" />
          ) : (
            <ChevronLeft className="h-3.5 w-3.5" />
          )}
        </button>
      </aside>

      {/* 主内容区 */}
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}

