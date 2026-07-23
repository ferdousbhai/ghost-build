import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Route } from "../routes/index";
import "../styles.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Ghostbuild preview root is missing.");
}

const PreviewComponent = Route.options.component;
if (!PreviewComponent) {
  throw new Error("Ghostbuild preview route component is missing.");
}

createRoot(root).render(
  <StrictMode>
    <PreviewComponent />
  </StrictMode>,
);
