import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { getRouter } from "../router";
import "../styles.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("Ghostbuild preview root is missing.");
}

createRoot(root).render(
  <StrictMode>
    <RouterProvider router={getRouter()} />
  </StrictMode>,
);
