import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router-dom";
import { router } from "./router";
import { queryClient } from "./query-client";
// Self-hosted so the app makes no third-party request on load. The revamped
// type scale was measured against Inter specifically: it ships tabular figures
// and a slashed zero, which Avenir Next lacks, and trace ids and duration
// columns depend on both.
import "@fontsource-variable/inter/wght.css";
import "./index.css";
import { installNavModality } from "./utils/nav-modality";

installNavModality();

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <RouterProvider router={router} />
  </QueryClientProvider>
);
