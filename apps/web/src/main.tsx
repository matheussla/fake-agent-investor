import React from "react";
import { createRoot } from "react-dom/client";

function App() {
  return <main><h1>Paper Crypto Investor</h1><p>Paper trading · paused</p></main>;
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
