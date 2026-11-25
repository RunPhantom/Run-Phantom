import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import { Settings } from "lucide-react";
import { Link, NavLink, useLocation, useSearchParams } from "react-router-dom";
import { useSavedViews } from "../api/saved-views";
import { savedViewPath } from "../../../src/saved-views-protocol";
import { RunPhantomMark } from "./RunPhantomMark";
import { NAV_GROUPS, NAV_ITEMS, SETTINGS_NAV, isNavPathActive } from "../shell/navigation";
import { useNavCounts } from "../shell/use-nav-counts";

export { NAV_ITEMS } from "../shell/navigation";

export function NavSidebar() {
  const location = useLocation();
  const onSettings = isNavPathActive(location.pathname, SETTINGS_NAV.path);
  const { isMobile, setOpenMobile } = useSidebar();
  const counts = useNavCounts();
  const savedViews = useSavedViews();
  const [searchParams] = useSearchParams();
  const activeViewId = location.pathname === "/runs" ? searchParams.get("view") : null;
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
          {NAV_GROUPS.map(group => {
            const items = NAV_ITEMS.filter(item => item.group === group.id);
            if (items.length === 0) return null;
            return (
              <SidebarGroup key={group.id} className="px-3 pb-1 pt-4 group-data-[collapsible=icon]:px-2 group-data-[collapsible=icon]:pt-2">
                <p id={`rp-nav-group-${group.id}`} className="rp-eyebrow px-2 pb-1.5 group-data-[collapsible=icon]:hidden">{group.label}</p>
                <SidebarGroupContent>
                  <SidebarMenu aria-labelledby={`rp-nav-group-${group.id}`}>
                    {items.map(({ id, label, path, icon: Icon }) => {
                      const active = isNavPathActive(location.pathname, path);
                      const count = counts[id];
                      const index = NAV_ITEMS.findIndex(item => item.id === id);
                      return (
                        <SidebarMenuItem key={id}>
                          <SidebarMenuButton tooltip={label} asChild isActive={active} className="h-11 gap-3 px-2.5 lg:[@media(pointer:fine)]:h-8">
                            {/* replace when already inside this section: a plain
                                push added a history entry per click, so after a few
                                taps on the current tab the Back button did nothing
                                visible several presses in a row. */}
                            <NavLink to={path} end={false} replace={active} onClick={closeMobile} aria-describedby={count ? `rp-nav-count-${id}` : undefined}>
                              <Icon aria-hidden="true" className="hidden size-4 shrink-0 group-data-[collapsible=icon]:block" />
                              <span aria-hidden="true" className={`w-5 shrink-0 font-mono text-[11px] tabular-nums group-data-[collapsible=icon]:hidden ${active ? "text-rp-blue" : "text-rp-index"}`}>
                                {String(index + 1).padStart(2, "0")}
                              </span>
                              <span className={count ? "pr-8 text-sm" : "text-sm"}>
                                {label}
                              </span>
                            </NavLink>
                          </SidebarMenuButton>
                          {count && (
                            <SidebarMenuBadge
                              id={`rp-nav-count-${id}`}
                              className={`top-1/2 -translate-y-1/2 font-mono text-[11px] font-medium ${count.tone === "danger" ? "text-rp-danger" : "text-rp-ink-subtle"}`}
                            >
                              <span aria-hidden="true">{count.text}</span>
                              <span className="sr-only">{count.description}</span>
                            </SidebarMenuBadge>
                          )}
                        </SidebarMenuItem>
                      );
                    })}
                  </SidebarMenu>
                  {group.id === "debug" && !!savedViews.data?.length && (
                    <SidebarMenu aria-label="Saved views" className="mt-1 group-data-[collapsible=icon]:hidden">
                      {savedViews.data.map(view => {
                        const active = view.id === activeViewId;
                        const countText = view.count === null ? null : view.count >= 10_000 ? `${Math.floor(view.count / 1000)}k` : String(view.count);
                        return (
                          <SidebarMenuItem key={view.id}>
                            <SidebarMenuButton asChild isActive={active} className="h-11 gap-2 pl-9 pr-2.5 lg:[@media(pointer:fine)]:h-7">
                              <Link to={savedViewPath(view)} aria-current={active ? "page" : undefined} onClick={closeMobile}
                                aria-describedby={countText !== null ? `rp-view-count-${view.id}` : undefined} title={view.name}>
                                <span className={`truncate text-[13px] ${countText !== null ? "pr-8" : ""} ${active ? "" : "text-rp-ink-soft"}`}>{view.name}</span>
                              </Link>
                            </SidebarMenuButton>
                            {countText !== null && (
                              <SidebarMenuBadge id={`rp-view-count-${view.id}`} className="top-1/2 -translate-y-1/2 font-mono text-[11px] font-medium text-rp-ink-subtle">
                                <span aria-hidden="true">{countText}</span>
                                <span className="sr-only">{view.count} matching {view.count === 1 ? "run" : "runs"}</span>
                              </SidebarMenuBadge>
                            )}
                          </SidebarMenuItem>
                        );
                      })}
                    </SidebarMenu>
                  )}
                </SidebarGroupContent>
              </SidebarGroup>
            );
          })}
        </nav>
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border px-3 py-3 group-data-[collapsible=icon]:px-2">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton tooltip="Settings" isActive={onSettings} asChild className="h-11 gap-3 px-2.5 lg:[@media(pointer:fine)]:h-8">
              <NavLink to={SETTINGS_NAV.path} replace={onSettings} onClick={closeMobile}>
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
