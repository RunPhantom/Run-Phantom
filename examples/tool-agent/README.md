# Tool-calling support agent

A small customer-support agent that calls OpenAI, Anthropic or Gemini directly
with `fetch`, runs local tools in a loop, and exports every step to Run Phantom
as OpenTelemetry GenAI spans over OTLP/HTTP JSON. It has no dependencies beyond
Bun.

What a run shows in Run Phantom:

- the system prompt, the conversation and each model reply;
- every tool call with its JSON arguments and result;
- tool failures the agent recovers from, and failures that stop the run;
- token usage per model call, with an estimated cost;
- an optional `researcher` sub-agent that the main agent delegates to;
- several turns grouped under one conversation id.

## Run it

Start Run Phantom from the repository root (`bun run dev`), then:

```bash
cd examples/tool-agent
export OPENAI_API_KEY=...        # or ANTHROPIC_API_KEY / GEMINI_API_KEY
bun agent.ts --provider openai
```

Each turn prints the tool calls, the reply and a link to the run.

| Option | Meaning |
| --- | --- |
| `--provider openai\|anthropic\|gemini` | Provider to call. Default `openai`. |
| `--model <id>` | Model to use. Defaults: `gpt-5-nano`, `claude-haiku-4-5-20251001`, `gemini-2.5-flash`. |
| `--prompt <text>` | One user turn. Repeat it for a multi-turn conversation. |
| `--interactive` | Chat in the terminal. Every turn shares one conversation id. Type `exit` to stop. |
| `--subagent` | Adds a `delegate_research` tool that runs a nested `researcher` agent. |

Examples:

```bash
bun agent.ts --provider anthropic --prompt "Where is order A1002?" --prompt "Can I return it when it arrives?"
bun agent.ts --provider gemini --subagent --prompt "My headphones from order A1004 stopped charging."
bun agent.ts --provider openai --interactive
```

Google no longer serves `gemini-2.5-flash` to newly created API keys and
returns HTTP 404. If that happens, pass a model your key can use with
`--model`. The failed call is still recorded as a failed run.

## Scenario batch

`scenarios.ts` runs a fixed set of conversations against each provider so you
can see a realistic mix of runs:

| Scenario | What happens | Expected status |
| --- | --- | --- |
| `refund-damaged` | Looks up order A1001 and refunds it. | Run complete |
| `inventory-outage` | `check_inventory` times out for KB-200; the agent explains and carries on. | Completed · 1 tool error |
| `ledger-conflict` | `issue_refund` for A1005 hits a ledger conflict; the agent stops. | Run failed |
| `warranty-subagent` | Delegates a warranty question to the researcher sub-agent. | Run complete |
| `follow-up` | Two turns about order A1002 in one conversation. | Run complete |

```bash
bun scenarios.ts                                   # every scenario, every provider
bun scenarios.ts --provider openai,anthropic --scenario refund-damaged,ledger-conflict
bun scenarios.ts --gemini-model <model-id>         # per-provider model overrides
bun scenarios.ts --list
```

Every scenario uses a provider key, so skip providers you have no key for. The
whole batch with the default models costs well under $0.10. Models still choose
their own steps, so a run can differ from the expected status; the summary
reports any difference.

## The tools

The tools are deterministic and local: the same arguments always give the same
result.

| Tool | Behaviour |
| --- | --- |
| `lookup_order` | Orders A1001 to A1005. |
| `check_inventory` | Fails with a timeout for SKU `KB-200`. The agent can recover. |
| `issue_refund` | Applies the 30-day policy. For order A1005 it fails with a ledger conflict that stops the run. |
| `search_kb` | Keyword search over four policy articles. |

## Trace shape

Each user turn is one trace:

```text
invoke_agent support-agent           (root; conversation id, input and final answer)
├── chat gpt-5-nano                  (messages, tool definitions, usage)
├── execute_tool lookup_order        (arguments, result, error)
├── execute_tool delegate_research   (only with --subagent)
│   └── invoke_agent researcher
│       ├── chat gpt-5-nano
│       └── execute_tool search_kb
└── chat gpt-5-nano
```

Spans follow the OpenTelemetry GenAI semantic conventions:

- `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.request.model` and `gen_ai.response.model`;
- `gen_ai.input.messages`, `gen_ai.output.messages` and `gen_ai.system_instructions`;
- `gen_ai.usage.*` token counts and `gen_ai.tool.*` tool fields;
- error status and an `exception` event on failures.

Run Phantom also reads the `runphantom.event.name` and
`runphantom.conversation.id` attributes on the root span, which name the run
and group the turns.

Send traces somewhere else with the standard
`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` variable (default
`http://localhost:5947/v1/traces`).

## Check

```bash
bun run check
```
