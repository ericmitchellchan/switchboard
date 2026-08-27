import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { RootErrorBoundary } from "./components/RootErrorBoundary";
import "./styles/global.css";
// Tailwind utilities for PROJECT SURFACES only (no preflight) — see the file.
import "./styles/surfaces.css";

// RootErrorBoundary sits OUTSIDE StrictMode so it also catches a throw from
// App's own render / effects / commit phase — the class of failure that paints
// a BLACK WINDOW, because it propagates above every per-screen boundary (those
// mount inside App) and React unmounts the whole tree.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <RootErrorBoundary>
    <React.StrictMode>
      <App />
    </React.StrictMode>
  </RootErrorBoundary>
);
