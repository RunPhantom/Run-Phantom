import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { Activity, Bookmark, Search, Settings, CheckCircle2, FlaskConical, Coins, ClipboardCheck, FileCode2 } from "lucide-react";
import { NavLink, useLocation } from "react-router-dom";
import { RunPhantomMark } from "./RunPhantomMark";

export type Page = "runs" | "search" | "saved" | "settings" | "verification" | "evaluations" | "costs" | "review-queues" | "prompts";

export const NAV_ITEMS: { id: Page; label: string; path: string; icon: typeof Activity }[] = [
  { id: "runs", label: "Runs", path: "/runs", icon: Activity },
  { id: "search", label: "Search", path: "/search", icon: Search },
  { id: "saved", label: "Saved", path: "/saved", icon: Bookmark },
  { id: "verification", label: "Verification", path: "/verification", icon: CheckCircle2 },
  { id: "evaluations", label: "Evaluations", path: "/evaluations", icon: FlaskConical },
  { id: "costs", label: "Cost & usage", path: "/costs", icon: Coins },
  { id: "review-queues", label: "Review queues", path: "/review-queues", icon: ClipboardCheck },
  { id: "prompts", label: "Prompts", path: "/prompts", icon: FileCode2 },
];

function isNavPathActive(pathname: string, path: string): boolean {
  return pathname === path || pathname.startsWith(`${path}/`);
}

export function NavSidebar() {
  const location = useLocation();
  const onSettings = location.pathname === "/settings";
  const { isMobile, setOpenMobile } = useSidebar();
  const closeMobile = () => {
    if (isMobile) setOpenMobile(false);
  };

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className={`h-16 shrink-0 justify-center border-b border-sidebar-border px-3 py-0 group-data-[collapsible=icon]:px-2 ${isMobile ? "pr-14" : ""}`}>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild size="lg" className="h-auto flex-col items-start gap-1 px-2 py-1 !bg-transparent hover:!bg-rp-row-hover active:!bg-rp-row-hover">
              <NavLink to="/runs" aria-label="Run Phantom — trace workspace" replace={isNavPathActive(location.pathname, "/runs")} onClick={closeMobile}>
                <span className="flex items-center gap-2">
                  <RunPhantomMark decorative size={28} className="!size-7 shrink-0" />
                  <span className="whitespace-nowrap text-[20px] font-bold leading-none tracking-[-0.045em] text-rp-ink" style={{ fontFamily: "var(--font-display)" }}>
                    Run Phantom
                  </span>
                </span>
                <span data-runphantom-tagline className="block whitespace-nowrap text-xs leading-4 text-rp-ink-muted group-data-[collapsible=icon]:hidden">
                  See the run. Find the reason.
                </span>
              </NavLink>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <nav aria-label="Primary navigation">
          <SidebarGroup className="px-3 pt-5 group-data-[collapsible=icon]:px-2">
            <p className="rp-eyebrow px-2 pb-3 group-data-[collapsible=icon]:hidden">Workspace</p>
            <SidebarGroupContent>
              <SidebarMenu>
                {NAV_ITEMS.map(({ id, label, path, icon: Icon }, index) => {
                  const active = isNavPathActive(location.pathname, path);
                  return (
                    <SidebarMenuItem key={id}>
                      <SidebarMenuButton tooltip={label} asChild isActive={active} className="h-11 gap-3 px-2.5 lg:h-10">
                        {/* replace when already inside this section: a plain
                            push added a history entry per click, so after a few
                            taps on the current tab the Back button did nothing
                            visible several presses in a row. */}
                        <NavLink to={path} end={false} replace={active} onClick={closeMobile}>
                          <Icon aria-hidden="true" className="hidden size-4 shrink-0 group-data-[collapsible=icon]:block" />
                          <span aria-hidden="true" className={`w-5 shrink-0 font-mono text-[11px] tabular-nums group-data-[collapsible=icon]:hidden ${active ? "text-rp-blue" : "text-rp-index"}`}>
                            {String(index + 1).padStart(2, "0")}
                          </span>
                          <span className="text-sm">
                            {label}
                          </span>
                        </NavLink>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </nav>
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border px-3 py-3 group-data-[collapsible=icon]:px-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="Settings" isActive={onSettings} asChild className="h-11 gap-3 px-2.5 lg:h-10">
              <NavLink to="/settings" replace={isNavPathActive(location.pathname, "/settings")} onClick={closeMobile}>
                <Settings aria-hidden="true" className="size-4 shrink-0" />
                <span className="text-sm">
                  Settings
                </span>
              </NavLink>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
