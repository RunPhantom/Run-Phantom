import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "react-router-dom";
import { createAppRouter } from "./router";
import { queryClient } from "./query-client";
// Self-hosted so the app makes no third-party request on load. The revamped
// type scale was measured against Inter specifically: it ships tabular figures
// and a slashed zero, which Avenir Next lacks, and trace ids and duration
// columns depend on both.
import "@fontsource-variable/inter/wght.css";
import "./index.css";
import { installNavModality } from "./utils/nav-modality";

installNavModality();

const root = createRoot(document.getElementById("root")!);
void createAppRouter().then(router => {
  root.render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}).catch(() => {
  root.render(
    <main role="alert" className="flex min-h-full items-center justify-center px-5 py-10">
      <section className="flex w-full max-w-xl flex-col items-start gap-4 border border-dashed border-rp-danger-border bg-white px-6 py-10 sm:px-10">
        <p className="rp-eyebrow text-rp-danger"><span aria-hidden="true" className="rp-eyebrow-marker bg-rp-danger" />Workspace / Not loaded</p>
        <h1 className="rp-section-title">The workspace could not be loaded</h1>
        <p className="text-[13px] leading-[1.8] text-rp-ink-muted">The app code for this page failed to download. Check that Run Phantom is still running, then reload.</p>
        <button type="button" className="h-10 rounded-control bg-rp-blue px-4 text-[13px] font-medium text-white transition-colors duration-250 ease-standard hover:bg-rp-blue-hover" onClick={() => location.reload()}>Reload workspace</button>
      </section>
    </main>
  );
});
