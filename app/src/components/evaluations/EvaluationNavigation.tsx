import { Link } from "react-router-dom";
import { Button } from "../ui/button";
import "./evaluation-workspace.css";

type Workspace = "regression" | "evidence" | "findings" | "queues" | "prompts";
const views = [
  { id: "regression", label: "Regression workbench" },
  { id: "evidence", label: "External reports" },
  { id: "findings", label: "Finding comparison" },
] as const;

export function EvaluationNavigation({ active, onView }: { active: Workspace; onView?: (view: "regression" | "evidence" | "findings") => void }) {
  return <nav aria-label="Evaluation workspaces" className="evaluation-navigation">
    <div className="evaluation-navigation-primary">
      {views.map(view => onView
        ? <Button key={view.id} variant="ghost" aria-current={active === view.id ? "page" : undefined} onClick={() => onView(view.id)}>{view.label}</Button>
        : <Link key={view.id} aria-current={active === view.id ? "page" : undefined} to={view.id === "regression" ? "/evaluations" : `/evaluations?view=${view.id}`}>{view.label}</Link>)}
    </div>
    <div className="evaluation-navigation-curation">
      <Link to="/review-queues" aria-current={active === "queues" ? "page" : undefined}>Review queues</Link>
      <Link to="/prompts" aria-current={active === "prompts" ? "page" : undefined}>Prompt lab</Link>
    </div>
  </nav>;
}
