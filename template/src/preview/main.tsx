import { StrictMode, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import * as PreviewRoute from "../routes/index";
import "../styles.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Ghostbuild preview root is missing.");
}

const previewRouteModule = PreviewRoute as unknown as {
  Route?: { options: { component?: ComponentType } };
  default?: ComponentType;
};
const PreviewComponent =
  previewRouteModule.Route?.options.component ?? previewRouteModule.default;
if (!PreviewComponent) {
  throw new Error("Ghostbuild preview route component is missing.");
}

createRoot(root).render(
  <StrictMode>
    <PreviewComponent />
  </StrictMode>,
);
