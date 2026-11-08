import { useEffect, useRef, useState } from "react";
import { Link, NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { ChevronDown, Menu, X } from "lucide-react";
import { projectPath, type Project } from "../api/team";
import { TeamProvider, RequireSession, ProjectBoundary, useAccount, useProject, useTeam, useTeamPages } from "./context";
import { Action, ErrorNotice, Select, TeamBrand, useTask } from "./common";
import { AuthPage, AccountPage } from "./auth";
import { OverviewPage, ProjectsPage } from "./projects";
import { TracesPage } from "./traces";
import { ChecksPage } from "./checks";
import { AdminPage } from "./admin";
import { PricingPage } from "./pricing";
import { EvidencePage } from "./evidence";
import { PromptsPage } from "./prompts";
import { TeamReviewQueuesPage, TeamReviewRevisionPage } from "./review-queues";
import "./team.css";

function TeamShell({ children }: { children: React.ReactNode }) {
  const { client, clearSession } = useTeam(); const account = useAccount(); const task = useTask();
  return <div className="team-root"><a className="skip-link" href="#team-main">Skip to team workspace</a><div className="team-strip"><span><span aria-hidden="true" className="team-strip-dot" />Team workspace</span><span className="team-strip-note">Project access is checked on every request</span></div><header className="team-topbar"><TeamBrand /><nav aria-label="Account navigation"><Link to="/team">Projects</Link><Link to="/team/account" className="team-account-link" title={account.user.email}>{account.user.email}</Link><Action className="team-signout" disabled={task.busy} onClick={() => void task.run(() => client.request("/logout", { method: "POST", body: {} }), clearSession)}>Sign out</Action></nav></header><ErrorNotice error={task.error} />{children}</div>;
}
function ProjectShell() {
  const project = useProject(); const navigate = useNavigate(); const location = useLocation(); const [open, setOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const navigation = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open) return;
    navigation.current?.querySelector<HTMLAnchorElement>("a.active")?.focus();
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setOpen(false); menuButton.current?.focus(); }
    };
    window.addEventListener("keydown", dismiss);
    return () => window.removeEventListener("keydown", dismiss);
  }, [open]);
  const projects = useTeamPages<Project>(["projects"], "/projects", {}, 30_000);
  const items = projects.data?.pages.flatMap(page => page.items) ?? [];
  const links = [{ path: "", name: "Overview" }, { path: "traces", name: "Traces" }, { path: "checks", name: "Checks" }, { path: "costs", name: "Cost & usage" }, { path: "evidence", name: "External reports" }, { path: "prompts", name: "Prompts" }, { path: "review-queues", name: "Review queues" }, ...(project.role === "admin" ? [{ path: "members", name: "Members" }, { path: "keys", name: "Ingestion keys" }, { path: "audit", name: "Audit log" }] : [])];
  return <div className="team-workspace"><aside id="team-project-navigation" ref={navigation} className={`team-sidebar ${open ? "team-sidebar-open" : ""}`}>
    <div className="team-switcher"><label htmlFor="team-project-switcher" className="rp-eyebrow team-switcher-label">Project</label><Select id="team-project-switcher" value={project.id} onChange={event => { setOpen(false); navigate(projectPath(event.target.value)); }}>{!items.some(item => item.id === project.id) && <option value={project.id}>{project.name}</option>}{items.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</Select>{projects.hasNextPage && <Action onClick={() => void projects.fetchNextPage()}>More projects <ChevronDown size={14} /></Action>}</div>
    <nav aria-label="Project navigation">{links.map(({ path, name }, index) => <NavLink key={path} end={!path} to={`${projectPath(project.id)}${path ? `/${path}` : ""}`} onClick={() => { if (open) menuButton.current?.focus(); setOpen(false); }}><span aria-hidden="true" className="team-nav-index">{String(index + 1).padStart(2, "0")}</span>{name}</NavLink>)}</nav><dl className="team-sidebar-footer"><dt className="rp-eyebrow">Your role</dt><dd>{project.role}</dd></dl>
  </aside><div className="team-content"><div className="team-mobile-bar"><button ref={menuButton} type="button" className="team-action team-mobile-menu" aria-controls="team-project-navigation" aria-label={open ? "Close project navigation" : "Open project navigation"} aria-expanded={open} onClick={() => setOpen(!open)}>{open ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}<span className="team-mobile-menu-label">{project.name}</span></button></div><main id="team-main" tabIndex={-1} key={project.id}>
    <Routes location={location}><Route index element={<OverviewPage />} /><Route path="traces/*" element={<TracesPage />} /><Route path="checks/*" element={<ChecksPage />} /><Route path="costs" element={<PricingPage />} /><Route path="evidence" element={<EvidencePage />} /><Route path="prompts" element={<PromptsPage />} /><Route path="review-queues" element={<TeamReviewQueuesPage />} /><Route path="review-datasets/:datasetId/revisions/:version" element={<TeamReviewRevisionPage />} /><Route path="members" element={<AdminPage kind="members" />} /><Route path="keys" element={<AdminPage kind="keys" />} /><Route path="audit" element={<AdminPage kind="audit" />} /><Route path="*" element={<div className="team-page"><div className="team-empty"><h2>This team page does not exist</h2><p>Check the address, or return to the project overview.</p><Link to={projectPath(project.id)}>Open project overview</Link></div></div>} /></Routes>
  </main></div></div>;
}
function SignedInRoutes() {
  const session = useAccount();
  return <TeamShell key={session.session.id}><Routes><Route path="account" element={<main id="team-main" tabIndex={-1}><AccountPage /></main>} /><Route path="projects/:projectId/*" element={<ProjectBoundary><ProjectShell /></ProjectBoundary>} /><Route path="*" element={<main id="team-main" tabIndex={-1}><ProjectsPage /></main>} /></Routes></TeamShell>;
}
export default function TeamApp() {
  return <TeamProvider><Routes><Route path="login" element={<AuthPage />} /><Route path="invite" element={<AuthPage invite />} /><Route path="*" element={<RequireSession><SignedInRoutes /></RequireSession>} /></Routes></TeamProvider>;
}
