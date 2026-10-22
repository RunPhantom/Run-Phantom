# Evaluation distributions

In **Evaluations → Distributions and trends**, select 1–20 finished experiments, choose one exact check or one captured metric, and click **Analyze distribution**. No agent or evaluator is rerun. Existing automatic verdicts remain intact.

The list shows the latest 50 experiments. Add a retained experiment ID to select older evidence. Experiments appear in the order you select them; adjacent trends follow that order. Selection order does not establish chronology or independent sampling.

An exact check selects a case ID and rule index. It contributes one observation per experiment, so different checks or rubric meanings are never averaged together. A captured metric contributes every frozen case from each selected experiment. Units are score, tokens, milliseconds, reported USD cost or calls.

All experiments must have the same dataset identity, revision, frozen case definitions and membership, evaluation and snapshot versions, and evaluator versions. Incomplete or incompatible populations are refused. Complete cancelled experiments remain eligible; available numeric evidence and exclusions are retained. Frozen evidence remains available after deleting its live dataset and restarting the daemon.

## Read the result

Known observations are valid finite numbers. Actual zero is known. Missing values, invalid domains and withheld check scores are counted as excluded, with no coercion of strings. Check scores must be in the evaluator's normalized 0–1 scale. Token and call counts must be nonnegative safe integers; duration and reported cost must be finite and nonnegative. A known captured metric remains available independently of unavailable raw payloads.

Mean, sum, minimum, maximum, median, P90, P95 and P99 use the same numeric aggregation function for each experiment and the whole selected population. Quantiles use linear interpolation. If no finite observations exist, statistics stay unavailable. Sum overflow is explicitly unavailable; a finite mean can still be shown. Histogram intervals include their lower edge and exclude their upper edge, except the final interval includes its upper edge. Identical values use one bin; floating-point resolution can reduce the requested bin count.

Choose **Higher is preferred**, **Lower is preferred**, or **No preference** explicitly. “Improved” and “regressed” describe only the chosen numeric direction. Model scores remain advisory and do not prove measured execution quality or change a machine quality gate. A missing mean gives an unavailable adjacent trend. No preference produces no preference verdict, including equal means.

Displayed numbers are rounded. **Download distribution JSON** retains exact numeric values and exports the same current analysis DTO, including exclusions and limitations. Changing the selection or any analysis option clears the old result and download, and invalidates pending responses. On narrow screens, focus the per-experiment table and use arrow keys to scroll horizontally.

## Local API

The registered read-only endpoint is `POST /api/evaluations/analyses/score-distributions`. The request is closed: all four fields are required and unsupported fields are refused.

```json
{
  "experimentIds": ["retained-experiment-id"],
  "selector": { "kind": "check_score", "caseId": "frozen-case-id", "ruleIndex": 0 },
  "direction": "none",
  "bins": 10
}
```

Alternatively use `{"kind":"snapshot_metric","metric":"totalTokens"}`. Supported metric names are `inputTokens`, `outputTokens`, `totalTokens`, `durationMs`, `costUsd` and `toolCalls`. Rule indices are 0–7; bins are integers from 1–20; IDs must be unique.

The response format is `runphantom-score-distribution/v1`. It contains the admitted selection, dataset ID and revision, protocol versions, unit, overall statistics, ordered per-experiment statistics, adjacent trends and limitations. Raw prompts, inputs, outputs, rule text and model explanations are omitted. Private compatibility hashes are not published.

Selected whole frozen rows are counted and checked for UTF-8 bytes in the same transaction before materialization or JSON parsing: at most 4 MiB per experiment and 8 MiB in total. The final response and download are limited to 1 MiB. Existing repeated-trial analysis still requires at least two experiments.

Invalid requests receive 400, missing experiments 404, incomplete or incompatible evidence 409, and excessive selection or evidence 413. Requests handled by the analysis route use `Cache-Control: no-store`. This endpoint reads local frozen evidence and does not create experiments, change verdicts or send provider requests.
