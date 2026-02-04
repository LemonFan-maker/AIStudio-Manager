import { Routes, Route, Navigate } from "react-router-dom";
import Layout from "./components/Layout";
import Dashboard from "./pages/Dashboard";
import Accounts from "./pages/Accounts";
import Config from "./pages/Config";
import Logs from "./pages/Logs";
import Traffic from "./pages/Traffic";
import TokenStats from "./pages/TokenStats";

function App() {
  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<Dashboard />} />
        <Route path="accounts" element={<Accounts />} />
        <Route path="config" element={<Config />} />
        <Route path="logs" element={<Logs />} />
        <Route path="traffic" element={<Traffic />} />
        <Route path="token-stats" element={<TokenStats />} />
      </Route>
    </Routes>
  );
}

export default App;
