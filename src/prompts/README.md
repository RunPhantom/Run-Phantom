# Prompt revisions

The Prompts workspace saves an immutable revision each time an editor saves a
changed template. A revision contains its name, literal template, variable names,
SHA-256 digest and `literal-v1` policy. Compilation and export always use the
selected saved revision, including when a newer revision exists.

Use `{{variable_name}}` placeholders. Compilation inserts each supplied value
once as plain text. Dollar signs, braces introduced by a value and ordinary
nested JSON remain literal. Credential-bearing names, templates, variable names,
values and compiled output are refused through the existing mandatory privacy
floor. Refusal messages do not include the supplied content.

A save includes a UUID operation key. Repeating the same operation and payload
returns its original revision; changing that payload conflicts. Appending also
requires the current positive head revision. On a conflict the workspace retains
the draft and offers an explicit reload of the current saved revision. Choosing
history, changing prompts or leaving the workspace requires confirmation when a
draft has unsaved changes.

Team viewers can read, compile and export; editors can create and append;
administrators can remove prompts or clear all prompt content. The server uses
the authenticated project membership and its existing private SQLite connection.
It rechecks current role and request authority before reading an awaited body,
inside the transaction and before publishing a response. Project identifiers or
authority supplied in a body cannot select another owner. Ingestion keys do not
grant prompt access.

Removing a prompt permanently removes every revision's content and retains only
a reserved identity and operation digest to prevent old saves from recreating
it. These reservations count toward capacity. **Clear all prompts** requires an
explicit irreversible-removal confirmation. It removes prompt content and those
reservations only, rotates current request authority before deletion, and retains
other captured work. Clearing external reports or restarting the application
preserves prompt history.

Storage is limited to 100 reserved prompt identities per scope, 1,000 globally,
32 revisions per prompt, 10,000 revisions globally and 32 MiB of retained logical
UTF-8 data. Lists contain at most 50 summaries per page. Admission checks totals
in SQL before reading template payloads. Requests are limited to 64 KiB and
responses to 128 KiB. Errors and exports contain no credential-bearing content.

Team endpoints live under `/api/team/projects/:projectId/prompts`. Read a revision
at `/:id/revisions/:revision`, compile it with a POST to that path plus `/compile`
and `{ "variables": { "name": "literal value" } }`, or export it with GET plus
`/export`. Revision numbers are positive integers from 1 to 32; a missing revision
is refused instead of selecting another revision.

The local workspace and its bounded router use the existing selected local
SQLite owner. In this branch the local server mount and canonical migration
registration remain pending the coordinator's migration sequence. The local UI
reports an unavailable registry until that installation is complete. Team schema
version 3 installs the same two additive prompt tables and immutable-update
trigger through a preservation upgrade from the supported version 2 database.
