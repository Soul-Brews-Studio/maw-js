import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { PinLock } from "./components/PinLock";

createRoot(document.getElementById("root")!).render(
  <PinLock>
    <App />
  </PinLock>
);
