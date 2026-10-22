import type { ComparisonAttempt } from "./comparison-client";
const usd = (microusd: number) => `$${(microusd / 1000000).toFixed(6)}`;
export function ComparisonAccounting({ attempt, input, output, rateRevision }: {
  attempt: ComparisonAttempt; input: number | null; output: number | null; rateRevision: string | null;
}) {
  const figures = [
    { value: `${input ?? "Unavailable"} / ${output ?? "Unavailable"}`, label: "Input / output tokens", foot: "¹ Provider usage retained for this target. Missing counts are unavailable, not zero." },
    { value: attempt.observedEstimateUsd === null ? "Unavailable" : `$${attempt.observedEstimateUsd}`, label: "Observed price estimate", foot: `² Frozen rate: ${rateRevision ?? "reference removed with private content"}. Provider invoice unavailable.` },
    { value: usd(attempt.chargeMicrousd), label: "Retained accounting", foot: `³ ${attempt.accountingState.replace(/_/g, " ")}. Conservative accounting remains when pricing or usage is unknown.` },
  ];
  return <section className="comparison-accounting" aria-label={`Accounting sources for ${attempt.model}`}>
    <dl>{figures.map((figure, index) => <div key={figure.label}><dd>{figure.value}<sup aria-hidden="true">{["¹", "²", "³"][index]}</sup></dd><dt>{figure.label}</dt></div>)}</dl>
    <ol>{figures.map(figure => <li key={figure.label}>{figure.foot}</li>)}</ol>
    <p>Reservation {usd(attempt.reserveMicrousd)} · pending hold {usd(attempt.holdMicrousd)}</p>
  </section>;
}
