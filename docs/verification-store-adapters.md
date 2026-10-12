# Explicit query and state adapters

Run Phantom's browser SDK can observe explicitly selected application state and
library-reported query metadata. Register the adapter in the application that
owns the store, using the SDK returned by the paired Verification session.
No library, provider or private framework state is discovered automatically.

```ts
const runtime = sdk.connect({ url, sessionId, token });
const release = runtime.registerStore("cart", sdk.shapeStore(cartStore, {
  select: { count: "items.length", total: "totals.amount" },
}));
```

The shape source supplies `getState()` and `subscribe(listener)`, with a function
returned to unsubscribe. Pinia uses its documented public state/subscription:

```ts
const release = runtime.registerStore("cart", sdk.piniaStore(cart, {
  select: { count: "count", total: "nested.total" },
}));
```

A Pinia subscription is synchronous and detached from the component that
registered it. Release the returned handle when the application no longer needs
capture. Disconnect and document navigation release all acquired subscriptions.
Each read makes a new frozen selected snapshot, so mutating a live proxy does not
rewrite a prior before value. A selected path uses own data properties only;
nested application getters are not executed. Pinia's public `$state` accessor is
an explicitly authorized library operation. A selection label and path segment
cannot name credential-bearing fields; renaming a password field cannot remove
the mandatory privacy policy. Empty selection paths explicitly request the whole
value, which still has the same redaction and finite limits.

Query adapters require exact keys:

```ts
const release = runtime.registerStore("queries", sdk.queryStore(queryClient, {
  keys: [{ queryKey: ["orders", { page: 1 }] }],
}));
```

The state command exposes `value.queries[0]` with a public `keyId`, key,
availability, status, fetchStatus, isStale, dataUpdatedAt and hasError. Its key
structure applies the mandatory sensitive-field floor and known credential
scrubbing before encoding `keyId`, even if the application exempts those field
names elsewhere. A redacted identity makes the snapshot partial. Public
identities may collapse after redaction and must never be used for authoritative
matching. Query data and error messages are omitted by default. Add a selection
to expose only the requested data paths:

```ts
const release = runtime.registerStore("queries", sdk.queryStore(queryClient, {
  keys: [{ queryKey: ["orders", { page: 1 }], select: { count: "count" } }],
  includeErrorMessage: true,
}));
```

`includeErrorMessage` separately opts into the error's own data message string,
with at most 1000 UTF-16 units and the same whole-result UTF-8/work limits. Empty
strings are valid. An object, accessor or oversized selected message makes that
query unavailable; it does not expose extra error-body fields or coerce values.
Error presence/status can be inspected without that text. A source/body that was not
selected does not enter the snapshot. Library methods are trusted operations
explicitly supplied by the application; the SDK does not sandbox their execution
time or prevent Proxy traps. Query lookup uses the client's own defaulted hash
and an exact cache lookup, then checks the actual private canonical query key
again. `canonicalQueryKey` returns the exact finite local encoding; treat that
return value as private configuration, not as evidence safe to publish. It does not
allocate or traverse the whole query cache. A replaced cache, custom-hash key
mismatch, missing key or unsupported source becomes unavailable; unregister and
register anew after replacing a client/cache.

`isStale` is the library-reported query fact. `dataUpdatedAt` is the library's
source timestamp. Neither proves current server state, successful invalidation
of another cache, or completed business persistence. The supported structured
key subset is dense finite JSON: arrays, plain own-data objects, strings,
booleans, finite numbers and null. Object keys are sorted and array order/types
are preserved. Undefined, cycles, getters, functions, symbols, sparse arrays,
non-JSON instances and prototype fields are refused. Slash joining or user
coercion is never used. The encoding follows finite JSON identity, including
JSON's normalization of negative zero; it is not every library key format.

Read a shape or Pinia selected count using a normal state predicate:
`{kind:"state",store:"cart",path:"values.count",equals:2}`. Read query facts with
paths such as `queries.0.isStale` or selected data with `queries.0.values.count`.
A standalone check describes the current readable condition. A relative check
needs an actual declared `causal-click` before/after pair in the same document
and action turn. An expected value that already held before a no-op remains
inconclusive for `becomes`, even when a standalone current-state check passes.
Later asynchronous changes remain ordinary observations and cannot rewrite the
captured synchronous pair or establish a final operation result.

Start observation from the authenticated session's current cursor, not cursor
zero before the document generation. Command and report windows are daemon-owned.
The paired application supplies SDK-reported observations; this is not native
input authority or an independent trusted measurement of the application's
claims. Partial, redacted, cyclic, oversized, missing or failed reads remain
inconclusive for equality and causal claims. API state results retain availability
and a fixed reason when unavailable; no empty/healthy value is fabricated.

There are at most 20 selected query keys and 20 selected data paths across the
whole query adapter. Canonical keys have depth 4, 100-node, 32-item, 512-character
string and 2048-byte per-key bounds, with 4096 total canonical-key bytes at
configuration admission. State paths have at most 32 segments and 1024 characters;
selection labels are bounded to 128 characters. The complete adapter output uses
one 500-node, 16 KiB UTF-8 budget, depth 8 and 100 collection items, plus the existing
stricter transport/redaction limits. Selecting many paths does not multiply this
budget. Existing frame/event/queue limits also cover subscription events.
Complete equal snapshots coalesce; partial/error notifications do not disappear
as evidence of unchanged state. Buffer loss disconnects capture instead of
silently dropping the final observation.

A connection has at most 100 active registration release handles across all
stores, including duplicates. Admission reserves capacity before subscribing or
probing a source, so reentrant registration shares the same limit. Releasing a
handle returns capacity; failed acquisition returns its reservation, and
disconnect removes all registrations. The same original source, helper
kind, selected configuration and name shares one subscriber, with independent
idempotent release handles. The last handle removes the registration. A different
name/configuration for an already registered source is refused; release it before
changing the selected projection. Separate source objects may have separate names.
Plain reader functions retain their existing pull-only and duplicate-name
behavior. Stale callbacks cannot emit after release, disconnect or reconnection.
Failed acquisition cannot advertise a valid registration. If a source violates
its subscription contract by not returning an unsubscribe function, capture is
refused; the SDK cannot recover an unsubscribe handle that the library never
provided. Acquired cleanup exceptions are contained so they do not break app
behavior.

The native helper suite uses the existing QueryClient 5.101.4 dependency. Genuine
Pinia 4.0.3/Vue 3.5.43 compatibility is exercised through a private fixture with exact
registry/tarball integrity records and scripts disabled, with no product package
or lock changes. Without that optional private fixture, the browser application
uses an explicitly labeled Pinia-shaped fixture; that case is not genuine Pinia
compatibility. Actual source Chromium, copied executable and native-platform
qualification are separate evidence cells. The existing Verification workspace
shows persisted reports and SDK-reported before/after readings; these helpers do
not introduce a new UI or change global theme/composition.
