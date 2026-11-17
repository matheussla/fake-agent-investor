import { useEffect, useState } from "react";
import { Dashboard } from "./features/dashboard/Dashboard.js";

export function App() {
  const [path, setPath] = useState(window.location.pathname);

  useEffect(() => {
    const syncPath = () => setPath(window.location.pathname);
    window.addEventListener("popstate", syncPath);
    return () => window.removeEventListener("popstate", syncPath);
  }, []);

  const navigate = (destination: "/" | "/settings") => {
    if (window.location.pathname === destination) return;
    window.history.pushState({}, "", destination);
    setPath(destination);
  };

  return <Dashboard page={path === "/settings" ? "settings" : "dashboard"} onNavigate={navigate}/>;
}
