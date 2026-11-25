import { useLayoutEffect, useRef } from "react";
import { Button } from "../ui/button";
import "./evaluation-workspace.css";

export type EvaluationView = "regression" | "evidence" | "findings";
const views = [
  { id: "regression", label: "Datasets and experiments" },
  { id: "evidence", label: "External reports" },
  { id: "findings", label: "Compare findings" },
] as const;

/** Sub-navigation for the Evaluations page only; Review queues and Prompts live in the sidebar. */
export function EvaluationNavigation({ active, onView }: { active: EvaluationView; onView: (view: EvaluationView) => void }) {
  const nav = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const element = nav.current;
    const current = element?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!element || !current || element.scrollWidth <= element.clientWidth) return;
    const navBox = element.getBoundingClientRect(), currentBox = current.getBoundingClientRect();
    if (currentBox.left < navBox.left || currentBox.right > navBox.right) element.scrollLeft += currentBox.left - navBox.left - 20;
  }, [active]);
  return <nav ref={nav} aria-label="Evaluation workspaces" className="evaluation-navigation">
    <div className="evaluation-navigation-primary">
      {views.map(view => <Button key={view.id} variant="ghost" aria-current={active === view.id ? "page" : undefined} onClick={() => onView(view.id)}>{view.label}</Button>)}
    </div>
  </nav>;
}
