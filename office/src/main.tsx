import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { PinLock } from "./components/PinLock";

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <PinLock>
      <App />
    </PinLock>
  </ErrorBoundary>
);
