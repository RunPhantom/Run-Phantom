# Inspect retrieval and stream capture in Run Phantom

Run the local daemon, then send the finite offline example:

```sh
bun examples/capture-visibility/capture.ts http://127.0.0.1:5947
```

Open Runs and select the captured example. The overview and Span Tree show
retrieval collection, top K, result count, embedding dimensions, and observed
stream chunks. Input and output retain the application's authoritative messages.
A cancelled stream retains partial observations. A finished request with only
stream timing or finish metadata has unknown stream capture completion.

The example calls only the explicitly supplied local daemon. It does not call a
model provider, vector database, or install an instrumentation package.

## Optional application instrumentation

Use a compatible OTLP application SDK already installed in your own application.
Initialize it before importing modules that it instruments, and preserve your
application's existing tracer provider and shutdown ownership. Configure the SDK
with the following options where that SDK supports them:

```ts
captureSdk.init({
  otlpEndpoint: "http://127.0.0.1:5947",
  disableMetrics: true,
  disableEvents: true,
  captureMessageContent: false,
  maxContentLength: 2048,
  pricingJson: "./local-pricing.json",
});
```

The reviewed compatibility implementation appends `/v1/traces` to the endpoint.
Run Phantom accepts traces; use an application's existing provider
`forceFlush()` followed by its owned `shutdown()` before a short-lived process
exits. Do not initialize a second provider or layer overlapping framework and
provider patches onto an already instrumented request. Content capture must be
an explicit application choice, with a finite limit and secret filtering before
export. A finite receiver limit does not replace application privacy controls.
The local pricing file avoids the reviewed SDK's default remote pricing lookup.
These options are a compatibility recipe, not a claim that every SDK, provider,
framework, runtime, or module patch order was exercised here.

The reviewed vector search shape provides collection, filter, top K, result count
and query summary. It does not supply ranked documents or citations. Embedding
metadata does not supply vector bytes. Missing fields stay "Not captured".
Reported cache and reasoning token categories are shown separately; they are not
added again to the authoritative input/output token totals.

## Explicit stream observations

For bounded application-owned capture, place the following OTLP events on the
same exact source span:

- `runphantom.stream.chunk`: nonnegative integer `runphantom.stream.sequence`
  starting at zero, and a captured string `runphantom.stream.text`.
- `runphantom.stream.completed`: explicit nonnegative integer
  `runphantom.stream.chunk_count` containing the whole declared roster.
- `runphantom.stream.cancelled` or `runphantom.stream.error`: retain observed
  chunks and declare the actual terminal outcome.

Emit known exporter loss counts, including explicit zero
`droppedEventsCount`/`droppedAttributesCount`, on the span and each stream event.
Completed capture requires every declared chunk, contiguous ordering, no
conflicting observations, and no capture loss or unavailable text. Limits are
64 unique chunks, 2,048 UTF-16 units per chunk, 16,384 total chunk text units and
65,536 UTF-8 bytes per projected view. Oversize content is withheld whole with
visible incomplete coverage. Metadata-only streams remain unknown. Stream
observations do not replace or concatenate into the final assistant message.

Identical repeated chunk identity within one source span is combined and counted.
Different spans remain different evidence, even when framework and provider
instrumentation overlap. Run Phantom does not guess cross-span equivalence.
