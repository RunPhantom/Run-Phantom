export function ComparisonBreadcrumb({ scopeLabel, revision }: { scopeLabel: string; revision: number | null }) {
  return <nav aria-label="Comparison breadcrumb" className="comparison-breadcrumb">
    <span>{scopeLabel}</span><span aria-hidden="true">/</span><a href="#prompt-preview-title">Prompts</a>
    <span aria-hidden="true">/</span><span>{revision === null ? "History" : `Revision ${revision}`}</span>
    <span aria-hidden="true">/</span><span aria-current="location">Comparison</span>
  </nav>;
}
