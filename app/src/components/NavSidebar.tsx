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
import { Activity, Bookmark, Search, Settings, CheckCircle2, FlaskConical } from "lucide-react";
import { NavLink, useLocation } from "react-router-dom";
import { RunPhantomMark } from "./RunPhantomMark";

export type Page = "runs" | "search" | "saved" | "settings" | "verification" | "evaluations";

const NAV_ITEMS: { id: Page; label: string; path: string; icon: typeof Activity }[] = [
  { id: "runs", label: "Runs", path: "/runs", icon: Activity },
  { id: "search", label: "Search", path: "/search", icon: Search },
  { id: "saved", label: "Saved", path: "/saved", icon: Bookmark },
  { id: "verification", label: "Verification", path: "/verification", icon: CheckCircle2 },
  { id: "evaluations", label: "Evaluations", path: "/evaluations", icon: FlaskConical },
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
      <SidebarHeader className="px-2 pt-2 pb-1">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild size="lg" className="!bg-transparent hover:!bg-[color:var(--rp-ink-wash)] active:!bg-[color:var(--rp-ink-wash)]">
              <NavLink to="/runs" aria-label="Run Phantom — trace workspace" replace={isNavPathActive(location.pathname, "/runs")} onClick={closeMobile}>
                <RunPhantomMark decorative size={22} className="shrink-0 text-[color:var(--rp-ink-strong)]" />
                <span className="min-w-0 leading-none">
                  <span className="block text-[13px] font-semibold tracking-[-0.01em] text-[color:var(--rp-ink-strong)]" style={{ fontFamily: "var(--font-display)" }}>
                    Run Phantom
                  </span>
                  <span data-runphantom-tagline className="mt-1 block truncate text-[9px] font-medium tracking-[0.02em] text-[color:var(--rp-ink-muted)]">
                    See the run. Find the reason.
                  </span>
                </span>
              </NavLink>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <nav aria-label="Primary navigation">
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                {NAV_ITEMS.map(({ id, label, path, icon: Icon }) => {
                  const active = isNavPathActive(location.pathname, path);
                  return (
                    <SidebarMenuItem key={id}>
                      <SidebarMenuButton tooltip={label} asChild isActive={active} size="sm">
                        {/* replace when already inside this section: a plain
                            push added a history entry per click, so after a few
                            taps on the current tab the Back button did nothing
                            visible several presses in a row. */}
                        <NavLink to={path} end={false} replace={active} onClick={closeMobile}>
                          <Icon className={`size-3.5 shrink-0 transition-opacity duration-150 ${active ? "opacity-100" : "opacity-60 group-hover/menu-item:opacity-85"}`} />
                          <span className={`text-[11px] transition-opacity duration-150 ${active ? "opacity-100" : "opacity-70 group-hover/menu-item:opacity-90"}`}>
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

      <SidebarFooter className="p-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="Settings" isActive={onSettings} asChild size="sm">
              <NavLink to="/settings" replace={isNavPathActive(location.pathname, "/settings")} onClick={closeMobile}>
                <Settings className={`size-3.5 shrink-0 transition-opacity duration-150 ${onSettings ? "opacity-100" : "opacity-60 group-hover/menu-item:opacity-85"}`} />
                <span className={`text-[11px] transition-opacity duration-150 ${onSettings ? "opacity-100" : "opacity-70 group-hover/menu-item:opacity-90"}`}>
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
