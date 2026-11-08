import type { ComparisonAttempt } from "./comparison-client";
const usd = (microusd: number) => `$${(microusd / 1000000).toFixed(6)}`;
// The stored estimate is String(float sum) and can carry binary noise such as 0.00010999999999999999.
const estimate = (value: string) => `$${Number(value).toLocaleString("en-US", { maximumSignificantDigits: 12, useGrouping: false })}`;
const charged: Record<string, { label: string; foot: string }> = {
  not_started: { label: "Charged", foot: "³ No provider request was sent, so nothing is charged." },
  measured_estimate: { label: "Charged · observed estimate", foot: "³ The observed price estimate, rounded up to a whole micro-dollar." },
  conservative: { label: "Charged · reserved maximum", foot: "³ Provider usage is unknown, so the full reservation stays charged as a worst case. This is not the observed cost." },
  unrepresentable_overage: { label: "Charged · capped", foot: "³ The observed estimate could not be represented within the charge cap; the cap is charged instead." },
};
export function ComparisonAccounting({ attempt, input, output, rateRevision }: {
  attempt: ComparisonAttempt; input: number | null; output: number | null; rateRevision: string | null;
}) {
  const figures = [
    { value: `${input ?? "Unavailable"} / ${output ?? "Unavailable"}`, label: "Input / output tokens", foot: "¹ Provider usage retained for this target. Missing counts are unavailable, not zero." },
    { value: attempt.observedEstimateUsd === null ? "Unavailable" : estimate(attempt.observedEstimateUsd), label: "Observed price estimate", foot: `² Frozen rate: ${rateRevision ?? "reference removed with private content"}. Provider invoice unavailable.` },
    { value: usd(attempt.chargeMicrousd), ...charged[attempt.accountingState] ?? charged.unrepresentable_overage },
  ];
  return <section className="comparison-accounting" aria-label={`Accounting sources for ${attempt.model}`}>
    <dl>{figures.map((figure, index) => <div key={figure.label}><dd>{figure.value}<sup aria-hidden="true">{["¹", "²", "³"][index]}</sup></dd><dt>{figure.label}</dt></div>)}</dl>
    <ol>{figures.map(figure => <li key={figure.label}>{figure.foot}</li>)}</ol>
    <p>Reservation {usd(attempt.reserveMicrousd)} · pending hold {usd(attempt.holdMicrousd)}</p>
  </section>;
}
