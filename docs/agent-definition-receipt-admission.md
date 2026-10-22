# Public definition receipt admission

Portable imports and privileged local diagnostic SQL retain the original captured
receipt. Public definition projection admits a relevant typed receipt only after
the existing 256 KiB character/UTF-8 byte ceiling and a lexical duplicate-object-key
check, followed by normal JSON syntax and closed receipt validation.

Duplicate JSON object members are ambiguous even if their final parsed value
looks safe. JSON parsing keeps the last member, while the original raw string
can still contain earlier private definition content. The existing duplicate-key
scanner therefore examines bounded receipt text before that lexical information
is discarded. Escaped-equivalent names are the same key. Ambiguity at any depth
of a relevant receipt uses the existing unavailable/refusal path; projection
does not guess a member, mint source facts or return the original raw companion.

An ordered attributes array may deliberately contain distinct entries with the
same attribute key. Those are separate observations rather than duplicate JSON
object members. Public projection retains their order and exact unrelated values,
withholds each private definition value and counts actual withholding. A genuine
business string containing JSON-looking text is still a string; its internal
text is not treated as receipt object structure.

The import can remain accepted while an ambiguous stored receipt makes public
run detail/export unavailable through the existing sanitized errors. Safe span
metadata and bounded search retain their current behavior. Privileged diagnostic
SQL, input/output, raw receipt bytes and row identity remain unchanged. This is
a public projection guard, not an import rewrite or a diagnostic SQL sandbox.
Existing search acquisition ceilings (2000 rows, 16 MiB aggregate and 256 KiB
typed companions), protocols and capture schemas are unchanged.

Regressions use actual parsed OTLP receipts and admitted portable imports. They
cover private-first/private-last, plain/escaped duplicate members in span,
resource, scope, event, link, capture and value objects, exact private storage,
healthy neighboring runs and legal ordered attribute-array collisions. Source
HTTP/browser qualification and copied/native-platform qualification remain
separate evidence stages.
