import { useEffect, useState } from "react";
import { ReportsPage } from "./features/reports/ReportsPage.js";
import { AgentsPage } from "./features/agents/AgentsPage.js";
import { Dashboard } from "./features/dashboard/Dashboard.js";

const readPath = () => {
  const path = window.location.pathname.replace(/\/+$/, "") || "/";
  return path === "/agents" || path === "/settings" || path === "/reports" ? path : "/";
};

export function App() {
  const [path, setPath] = useState(readPath);
  const [visited, setVisited] = useState(() => new Set([readPath()]));

  useEffect(() => {
    const syncPath = () => {
      setPath(readPath());
      setVisited((current) => new Set(current).add(readPath()));
    };
    window.addEventListener("popstate", syncPath);
    return () => window.removeEventListener("popstate", syncPath);
  }, []);

  const navigate = (destination: "/" | "/settings" | "/agents" | "/reports") => {
    if (window.location.pathname === destination) return;
    window.history.pushState({}, "", destination);
    setPath(destination);
    setVisited((current) => new Set(current).add(destination));
  };

  return <>
    {(["/", "/agents", "/reports", "/settings"] as const).map((route) => visited.has(route) && <div key={route} hidden={path !== route}>
      {route === "/reports" ? <ReportsPage active={path === route} onNavigate={navigate}/> : route === "/agents" ? <AgentsPage active={path === route} onNavigate={navigate}/> : <Dashboard active={path === route} page={route === "/settings" ? "settings" : "dashboard"} onNavigate={navigate}/>}
    </div>)}
  </>;
}
