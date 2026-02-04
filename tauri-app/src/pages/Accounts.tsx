import { useEffect, useState } from "react";
import { api, SystemStatus } from "@/lib/api";
import {
  Users,
  Upload,
  RefreshCw,
  CheckCircle,
  XCircle,
  AlertCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";

export default function Accounts() {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [message, setMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  const [uploadForm, setUploadForm] = useState({
    storageState: "",
    accountName: "",
    targetIndex: "",
  });

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

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleSwitchAccount = async (targetIndex: number) => {
    try {
      setSwitching(true);
      setMessage(null);
      const result = await api.switchAccount(targetIndex);
      setMessage({ type: "success", text: result });
      await fetchStatus();
    } catch (err) {
      setMessage({
        type: "error",
        text: err instanceof Error ? err.message : "切换失败",
      });
    } finally {
      setSwitching(false);
    }
  };

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setUploading(true);
      setMessage(null);

      let storageStateObj;
      try {
        storageStateObj = JSON.parse(uploadForm.storageState);
      } catch {
        throw new Error("storageState 不是有效的 JSON 格式");
      }

      const result = await api.uploadAuth({
        storageState: storageStateObj,
        accountName: uploadForm.accountName || undefined,
        targetIndex: uploadForm.targetIndex
          ? parseInt(uploadForm.targetIndex)
          : undefined,
      });

      setMessage({
        type: "success",
        text: `成功上传！账号索引: ${result.index}`,
      });
      setUploadForm({ storageState: "", accountName: "", targetIndex: "" });
      await fetchStatus();
    } catch (err) {
      setMessage({
        type: "error",
        text: err instanceof Error ? err.message : "上传失败",
      });
    } finally {
      setUploading(false);
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (event) => {
        const content = event.target?.result as string;
        setUploadForm((prev) => ({ ...prev, storageState: content }));
      };
      reader.readAsText(file);
    }
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <RefreshCw className="mx-auto h-12 w-12 animate-spin text-primary" />
          <p className="mt-4 text-sm text-muted-foreground">加载中...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold">账号管理</h1>
        <p className="mt-2 text-muted-foreground">管理和切换代理账号</p>
      </div>

      {!api.getSavedApiKey() && (
        <div className="mb-6 rounded-lg border border-yellow-500 bg-yellow-50 p-4 dark:bg-yellow-950">
          <div className="flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-yellow-600 dark:text-yellow-400" />
            <div className="flex-1">
              <p className="font-medium text-yellow-900 dark:text-yellow-100">
                请先配置 API Key
              </p>
              <p className="mt-1 text-sm text-yellow-800 dark:text-yellow-200">
                在上传账号前，请先到"配置"页面设置 API Key（默认: 123456）
              </p>
            </div>
          </div>
        </div>
      )}

      {message && (
        <div
          className={cn(
            "mb-6 rounded-lg border p-4",
            message.type === "success"
              ? "border-green-500 bg-green-50 text-green-900"
              : "border-red-500 bg-red-50 text-red-900"
          )}
        >
          <div className="flex items-center gap-2">
            {message.type === "success" ? (
              <CheckCircle className="h-5 w-5" />
            ) : (
              <XCircle className="h-5 w-5" />
            )}
            <p className="text-sm font-medium">{message.text}</p>
          </div>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="rounded-lg border border-border bg-card p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-xl font-semibold">账号列表</h2>
            <Users className="h-5 w-5 text-muted-foreground" />
          </div>

          <div className="space-y-3">
            {status?.accountDetails.map((account) => (
              <div
                key={account.index}
                className={cn(
                  "flex items-center justify-between rounded-lg border p-4 transition-colors",
                  account.index === status.currentAuthIndex
                    ? "border-primary bg-primary/5"
                    : "border-border hover:bg-accent"
                )}
              >
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">账号 #{account.index}</span>
                    {account.index === status.currentAuthIndex && (
                      <span className="rounded bg-primary px-2 py-0.5 text-xs text-primary-foreground">
                        当前
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {account.name}
                  </p>
                </div>
                {account.index !== status.currentAuthIndex && (
                  <button
                    onClick={() => handleSwitchAccount(account.index)}
                    disabled={switching}
                    className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  >
                    {switching ? "切换中..." : "切换"}
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-border bg-card p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-xl font-semibold">上传新账号</h2>
            <Upload className="h-5 w-5 text-muted-foreground" />
          </div>

          <form onSubmit={handleUpload} className="space-y-4">
            <div>
              <label className="mb-2 block text-sm font-medium">
                选择 storageState.json 文件
              </label>
              <input
                type="file"
                accept=".json"
                onChange={handleFileUpload}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm file:mr-4 file:rounded-lg file:border-0 file:bg-primary file:px-3 file:py-1 file:text-sm file:font-medium file:text-primary-foreground"
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium">
                storageState JSON 内容 *
              </label>
              <textarea
                value={uploadForm.storageState}
                onChange={(e) =>
                  setUploadForm((prev) => ({
                    ...prev,
                    storageState: e.target.value,
                  }))
                }
                placeholder='{"cookies": [...], "origins": [...], "accountName": ...}'
                required
                rows={6}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm font-mono"
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium">
                账号名称（可选）
              </label>
              <input
                type="text"
                value={uploadForm.accountName}
                onChange={(e) =>
                  setUploadForm((prev) => ({
                    ...prev,
                    accountName: e.target.value,
                  }))
                }
                placeholder="例如：user@gmail.com"
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium">
                指定索引（可选）
              </label>
              <input
                type="number"
                min="1"
                value={uploadForm.targetIndex}
                onChange={(e) =>
                  setUploadForm((prev) => ({
                    ...prev,
                    targetIndex: e.target.value,
                  }))
                }
                placeholder="留空自动分配"
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
              />
            </div>

            <button
              type="submit"
              disabled={uploading || !uploadForm.storageState}
              className="w-full rounded-lg bg-primary px-4 py-2 font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {uploading ? "上传中..." : "上传账号"}
            </button>
          </form>

          <div className="mt-6 rounded-lg bg-muted p-4">
            <div className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-muted-foreground" />
              <div className="text-xs text-muted-foreground">
                <p className="font-medium">如何获取 storageState.json？</p>
                <ol className="mt-2 list-decimal space-y-1 pl-4">
                  <li>在本地运行 save-auth.js 脚本</li>
                  <li>使用浏览器登录 Google AI Studio</li>
                  <li>脚本会自动生成 auth/auth-N.json 文件</li>
                  <li>复制文件内容或直接上传文件</li>
                </ol>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
