import { Outlet, NavLink } from "react-router-dom";
import {
  LayoutDashboard,
  Users,
  Settings,
  ScrollText,
  Activity,
  BarChart3,
  PieChart,
} from "lucide-react";
import { cn } from "@/lib/utils";

const navItems = [
  { path: "/dashboard", icon: LayoutDashboard, label: "仪表盘" },
  { path: "/accounts", icon: Users, label: "账号管理" },
  { path: "/traffic", icon: BarChart3, label: "流量统计" },
  { path: "/token-stats", icon: PieChart, label: "Token 统计" },
  { path: "/logs", icon: ScrollText, label: "日志" },
  { path: "/config", icon: Settings, label: "配置" },
];

export default function Layout() {
  return (
    <div className="flex h-screen bg-background">
      {/* 侧边栏 */}
      <aside className="w-64 border-r border-border bg-card">
        <div className="flex h-16 items-center gap-2 border-b border-border px-6">
          <Activity className="h-6 w-6 text-primary" />
          <h1 className="text-xl font-bold">AIStudio Manager</h1>
        </div>
        <nav className="space-y-1 p-4">
          {navItems.map((item) => (
            <NavLink
              key={item.path}
              to={item.path}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                )
              }
            >
              <item.icon className="h-5 w-5" />
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>

      {/* 主内容区 */}
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
