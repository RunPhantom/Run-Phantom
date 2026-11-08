import { type CSSProperties, useEffect, useRef, useState } from "react";
import {
  type RouteObject,
  Link,
  Navigate,
  Outlet,
  useLocation,
  useMatch,
} from "react-router-dom";
import { SidebarProvider, SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import { NavSidebar, NAV_ITEMS } from "./components/NavSidebar";
import { MessagePane } from "./components/MessagePane";
import { RunsPage } from "./pages/RunsPage";
import { CostAnalyticsPage } from "./pages/CostAnalyticsPage";
import { SearchPage } from "./pages/SearchPage";
import { SavedPage } from "./pages/SavedPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { SettingsPage } from "./pages/SettingsPage";
import { VerificationPage } from "./pages/VerificationPage";
import { EvaluationsPage } from "./pages/EvaluationsPage";
import { ReviewQueuesRoute } from "./components/review-queues/ReviewQueuesRoute";
import { PromptsPage } from "./pages/PromptsPage";
import { RouteError } from "./components/RouteError";
import { sendRunPhantomMessage, useRunPhantomConnectionStatus } from "./hooks/use-runphantom-ws";
import { useAgentUiCommands } from "./hooks/use-agent-ui-commands";
import { useDialogFocus } from "./hooks/use-dialog-focus";
import { safeDecodeParam } from "./utils/helpers";

const DISCONNECTED_NOTICE_DELAY_MS = 100;

function AppLayout() {
  const location = useLocation();
  const [showDisconnectedNotice, setShowDisconnectedNotice] = useState(false);
  const disconnectedDialogRef = useRef<HTMLDivElement>(null);
  const runMatch = useMatch({ path: "/runs/:runId", end: false });
  const activeRunId = runMatch?.params.runId
    ? safeDecodeParam(runMatch.params.runId)
    : null;
  const connectionStatus = useRunPhantomConnectionStatus();
  const section = NAV_ITEMS.find(({ path }) => location.pathname === path || location.pathname.startsWith(`${path}/`))?.label
    ?? (location.pathname === "/settings" ? "Settings" : "Workspace");
  useAgentUiCommands();
  useDialogFocus(showDisconnectedNotice, disconnectedDialogRef);

  useEffect(() => {
    if (connectionStatus !== "disconnected") {
      setShowDisconnectedNotice(false);
      return;
    }
    const timeout = window.setTimeout(() => {
      setShowDisconnectedNotice(true);
    }, DISCONNECTED_NOTICE_DELAY_MS);
    return () => window.clearTimeout(timeout);
  }, [connectionStatus]);

  useEffect(() => {
    sendRunPhantomMessage({ type: "ui_view", run_id: activeRunId });
  }, [activeRunId]);

  return (
    <div className="flex h-svh flex-col" style={{ "--rp-strip-h": "28px" } as CSSProperties}>
      <a href="#runphantom-main" className="skip-link">Skip to trace workspace</a>
      <DaemonStatusStrip status={connectionStatus} />
      <SidebarProvider defaultOpen className="min-h-0 flex-1">
        <NavSidebar />
        <SidebarInset id="runphantom-main" tabIndex={-1}>
          <div className="relative flex h-full flex-col overflow-hidden">
            <header data-workspace-header className="flex h-16 shrink-0 items-center justify-between gap-3 border-b border-rp-line bg-white px-4 lg:px-8">
              <div className="flex min-w-0 items-center gap-4">
                <SidebarTrigger className="size-11 shrink-0 rounded-control border border-rp-line text-rp-ink hover:bg-rp-row-hover hover:text-rp-ink lg:size-9" />
                <nav aria-label="Workspace breadcrumb" className="min-w-0 text-[13px]">
                  <ol className="flex min-w-0 items-center gap-3">
                    <li className="hidden shrink-0 sm:block"><Link to="/runs" className="text-rp-ink-muted transition-colors duration-250 ease-standard hover:text-rp-blue">Workspace</Link></li>
                    <li aria-hidden="true" className="hidden text-rp-ink-faint sm:block">/</li>
                    <li aria-current={activeRunId ? undefined : "page"} className="shrink-0 font-medium text-rp-ink">{section}</li>
                    {activeRunId && <>
                      <li aria-hidden="true" className="text-rp-ink-faint">/</li>
                      <li aria-current="page" title={activeRunId} className="rp-meta min-w-0 truncate">{activeRunId}</li>
                    </>}
                  </ol>
                </nav>
              </div>
            </header>
            <div
              className={`flex min-h-0 flex-1 transition-opacity duration-200 has-[[data-debug-launcher]]:pb-16 ${showDisconnectedNotice ? "pointer-events-none select-none opacity-45" : ""}`}
              aria-hidden={showDisconnectedNotice}
            >
              <div className="flex-1 min-w-0 overflow-auto">
                <Outlet />
              </div>
              <MessagePane activeRunId={activeRunId} />
            </div>
            {showDisconnectedNotice && (
              <div className="absolute inset-0 z-50 flex items-center justify-center bg-[color:var(--rp-scrim-soft)] px-6">
                <div
                  ref={disconnectedDialogRef}
                  role="alertdialog"
                  aria-modal="true"
                  aria-labelledby="runphantom-disconnected-title"
                  aria-describedby="runphantom-disconnected-description"
                  tabIndex={-1}
                  className="flex w-[520px] max-w-full flex-col items-start rounded-lg border border-rp-line bg-white p-6 text-left shadow-e4 animate-fade-rise sm:p-8"
                >
                  <p className="rp-eyebrow text-rp-danger">
                    <span aria-hidden="true" className="rp-eyebrow-marker bg-rp-danger" />
                    Local daemon offline
                  </p>
                  <h1 id="runphantom-disconnected-title" className="rp-section-title mt-3">Run Phantom isn&apos;t running.</h1>
                  <div id="runphantom-disconnected-description" className="mt-3 text-sm leading-6 text-rp-ink-muted">
                    Run <code className="rounded-control border border-rp-line bg-rp-canvas-blue px-1.5 py-0.5 font-mono text-[13px] text-rp-ink">runphantom</code> from your terminal to resume.
                  </div>
                </div>
              </div>
            )}
          </div>
        </SidebarInset>
      </SidebarProvider>
    </div>
  );
}

function DaemonStatusStrip({ status }: { status: ReturnType<typeof useRunPhantomConnectionStatus> }) {
  const label = status === "connected" ? "Connected" : status === "connecting" ? "Connecting" : "Disconnected";
  return (
    <div className={`flex h-[var(--rp-strip-h)] shrink-0 items-center justify-between gap-4 px-4 text-[11px] font-medium leading-4 text-white transition-colors duration-250 ease-standard lg:px-8 ${status === "disconnected" ? "bg-rp-danger" : "bg-rp-blue"}`}>
      <p data-connection-status={status} role="status" className="flex min-w-0 items-center gap-2">
        <span aria-hidden="true" className={`size-[5px] shrink-0 rounded-full bg-white ${status === "connecting" ? "pulse-dot" : ""}`} />
        <span className="truncate">Local daemon · {label}</span>
      </p>
      <p className="hidden shrink-0 text-white/85 sm:block">Traces are stored on this machine</p>
    </div>
  );
}

export const localRoutes: RouteObject[] = [
  {
    path: "/",
    element: <AppLayout />,
    // Child routes carry their own errorElement so a page-level throw keeps the nav
    // chrome mounted and every other trace reachable; this one is the last line of
    // defence for a throw in the layout itself.
    errorElement: <RouteError />,
    children: [
      { index: true, element: <Navigate to="/runs" replace />, errorElement: <RouteError /> },
      { path: "runs", element: <RunsPage />, errorElement: <RouteError /> },
      { path: "runs/:runId/span/:spanId", element: <RunsPage />, errorElement: <RouteError /> },
      { path: "runs/:runId/spans", element: <RunsPage />, errorElement: <RouteError /> },
      { path: "runs/:runId/convo", element: <RunsPage />, errorElement: <RouteError /> },
      { path: "runs/:runId", element: <RunsPage />, errorElement: <RouteError /> },
      { path: "search/:runId/span/:spanId", element: <SearchPage />, errorElement: <RouteError /> },
      { path: "search/:runId/spans", element: <SearchPage />, errorElement: <RouteError /> },
      { path: "search/:runId/convo", element: <SearchPage />, errorElement: <RouteError /> },
      { path: "search/:runId", element: <SearchPage />, errorElement: <RouteError /> },
      { path: "search", element: <SearchPage />, errorElement: <RouteError /> },
      { path: "saved/:runId/span/:spanId", element: <SavedPage />, errorElement: <RouteError /> },
      { path: "saved/:runId/spans", element: <SavedPage />, errorElement: <RouteError /> },
      { path: "saved/:runId/convo", element: <SavedPage />, errorElement: <RouteError /> },
      { path: "saved/:runId", element: <SavedPage />, errorElement: <RouteError /> },
      { path: "saved", element: <SavedPage />, errorElement: <RouteError /> },
      { path: "settings", element: <SettingsPage />, errorElement: <RouteError /> },
      { path: "verification", element: <VerificationPage />, errorElement: <RouteError /> },
      { path: "evaluations", element: <EvaluationsPage />, errorElement: <RouteError /> },
      { path: "costs", element: <CostAnalyticsPage />, errorElement: <RouteError /> },
      { path: "review-queues", element: <ReviewQueuesRoute />, errorElement: <RouteError /> },
      { path: "prompts", element: <PromptsPage />, errorElement: <RouteError /> },
      { path: "*", element: <NotFoundPage />, errorElement: <RouteError /> },
    ],
  },
];
