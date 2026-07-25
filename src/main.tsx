import React from "react";
import { createRoot } from "react-dom/client";
import AgentLatencyLab from "./AgentLatencyLab.jsx";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AgentLatencyLab />
  </React.StrictMode>
);
