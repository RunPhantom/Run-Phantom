# Semantic observations in Run Phantom

Pair a local application with the current browser SDK, then open **Verification → Semantic snapshots**. Give each observation a name and capture it before or after a change. Choose two saved observations to compare. Run Phantom shows represented additions, removals, matches and order changes; duplicates are counted separately.

These are SDK-reported observations with partial ARIA names. Differences do not establish which action caused them. “No observed semantic changes in the captured scope” describes the captured visible population, including its disclosed limitations. It does not establish that the entire application or business result is unchanged. Snapshots and comparisons create no verification verdicts.

The projected tree records the nearest retained semantic ancestor and explicit observed open-shadow or same-origin-frame boundaries. Ordinary wrappers can be omitted without inventing a parent from traversal depth. Hidden/private subtrees and form values are excluded. Closed shadow roots are unobservable; inaccessible frames, privacy loss and capture limits are disclosed. Partial text and uncertain boundary ownership are excluded from definite matches.

The current SDK negotiates protocol version 5 and the `semantic-tree` capability. Existing versions 1–4 keep their original capability contracts. Consumers can disable tree capture with `semanticSnapshots: false`; the capability is omitted and capture does not traverse the page. Disabling tree capture leaves separately enabled semantic references and optional source provenance available.

```ts
const connection = connect({ url, sessionId, token, semanticSnapshots: false });
```

Saved observations remain available after the target disconnects or the daemon restarts. Content digests describe represented content, not a DOM object. Saved indexes/digests never become live handles, cannot target `ref-click` or `ref-fill`, and do not consume or refresh the runtime's live-reference allowance. A document generation is page-reported provenance; the connection generation records the daemon's owned capture turn. Capture refuses a disconnected, replaced or malformed response instead of saving an empty success.

The local database retains at most 100 immutable observations. Each stored payload is at most 32 KiB. Captures retain at most 100 nodes/32 regions, 240 characters per text field and 16 KiB of tree JSON; the existing cumulative transport serializer can bind earlier. At capacity, delete an observation explicitly before capturing or importing. Existing observations are never silently evicted or overwritten. Explicit deletion also permits recovery from a known corrupt immutable record; corrupt records refuse read/export.

Use **Export selected snapshots** for one or two observations, and **Import snapshots** to transfer them. The separate `runphantom-semantic-snapshots/v1` artifact is bounded to 96 KiB and excludes local session/run/record IDs, pairing tokens and connection authority. Import validates the complete artifact, graph, privacy bounds and recomputed digests before one transaction. An invalid second observation or insufficient capacity saves none. Imported records get fresh local IDs and no live session/generation; repeated import creates distinct local records with the same represented content digest. A user-selected local run association is resolved only against the current database.

Comparison requires the same exact local origin and name model. Different document generations can be compared but are labeled as different documents. A partial capture retaining no comparable observations gives an unavailable comparison and unknown change counts; it cannot establish absence or unchanged content. A complete empty captured scope remains a distinct observation. The deterministic ordered display uses a bounded LCS; its insert/delete script is separate from the multiset counts. Work, output and partial-coverage limits are explicit. The compact display never changes the hashed or compared population.

Run Phantom is owned and maintained by Divyam Talwar.
