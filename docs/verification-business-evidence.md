# Response evidence for local application checks

Response capture is off by default. In Verification, select **Capture response evidence** before pairing, then connect your app with the generated setup. Changing the checkbox affects the next setup; reconnect the app to change its active capture scope. The response panel shows whether the connected app negotiated capture.

You can also opt in in your local development entry point:

```ts
const verification = connect({
  url: "http://localhost:5947",
  sessionId,
  token,
  businessResponses: true,
});
```

The observer inspects detached copies of responses your app already requested. It preserves the original fetch response, rejected promise behavior, and XHR output. It does not initiate requests, collect cookies or request headers/bodies, or download unavailable responses. Capture disabled means no cloning or body reading. Existing network checks continue to describe response headers and HTTP status.

Evidence distinguishes pending, complete, timeout, aborted, truncated, opaque, unsupported, and unavailable captures. Completion requires an observed end of the response. A quiet interval or HTTP 200 cannot complete an open stream. JSON, JSON media types with a `+json` suffix, JSON data records in SSE, and NDJSON are supported. XHR capture inspects completed bounded text responses; binary and other response modes remain unsupported. Unreadable, invalid, oversized, and incomplete responses retain no partial body.

The fixed limits are 32 KiB of input per response, 8 KiB of retained redacted content, four concurrent readers, 128 chunks, and 1.5 seconds. Sensitive decoded keys, known credential shapes, pairing credentials, and values entered through live fill commands are redacted before retention. The limits never turn a partial body into a complete business outcome. Redacted or truncated evidence cannot satisfy a response contract. An open stream does not delay ordinary HTTP metadata checks.

**Business response contract** checks require the endpoint, operation identity, the response's operation identity path, a value path, and an expected value. Paths use dot-separated own properties, including canonical array indexes. Missing values differ from null, false, and zero. For an NDJSON or SSE array, a path such as `1.operationId` addresses its second complete record.

- **Observed response** checks the readable value of a complete app-reported response for the declared operation.
- **Accepted request** additionally requires a successful HTTP status. A 202 acceptance can pass this contract while final persistence remains unverified.
- **Final server persistence** remains inconclusive: the SDK, rendered result, and app store cannot authenticate a final business server or database outcome.

An optional **Cross-channel witness** compares an explicitly declared registered store or application signal with the response. Both channels must expose the same operation identity and a readable value. A disagreement fails the declared comparison; a missing, disconnected, redacted, or differently identified witness remains inconclusive. These app channels describe observations without becoming an independent server witness.

The panel identifies possible business failures from conventional nonempty error fields and false success fields, including bounded batch records. Empty error objects, arrays, false, zero, and whitespace strings do not produce findings. Findings are advisory until you declare the expected API contract. Repeated requests retain distinct identities; equal body shape or length does not prove a duplicate write.

Live checks and saved flow replays use the same evaluator and retain the declared contract, bounded start/end cursors, status, reason, and response evidence. A response keeps the action identity captured at request start, so a delayed response from an earlier action cannot satisfy a later action's check. Reports describe their captured interval; reopening one does not create a new live proof.
