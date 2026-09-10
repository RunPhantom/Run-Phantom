export type EmbeddedSkillName = "instrument-agent" | "setup-agent-replay";

const SKILL_PROMPTS: Record<EmbeddedSkillName, string> = {
  "instrument-agent": [
    "Instrument this repository so a real local run appears in Run Phantom.",
    "",
    "Requirements:",
    "- find the real agent entry point and existing telemetry owner first",
    "- prefer the repo's existing OTLP/OpenTelemetry setup over adding a second provider",
    "- point local trace export at RUNPHANTOM_LOCAL_DEBUGGER=http://127.0.0.1:5947/v1/",
    "- make the smallest safe change that yields one useful run",
    "- verify the run appears in Run Phantom before adding richer spans",
    "",
    "Stop if the next edit would be a guess, and report the exact blocker.",
  ].join("\n"),
  "setup-agent-replay": [
    "Set up local replay for this agent so Run Phantom can replay captured traces against the real codebase.",
    "",
    "Requirements:",
    "- create or update .runphantom/agents.yaml",
    "- add a replay server with GET /health and POST /replay",
    "- keep replay ports within 61020-61044",
    "- set RUNPHANTOM_LOCAL_DEBUGGER=http://127.0.0.1:5947/v1/ before invoking the replayed agent",
    "- run runphantom replay register from the project root",
    "- verify the replay server becomes healthy and replay traces flow back into Run Phantom",
    "",
    "Stop if the agent is not already instrumented or if replay would require guessing hidden runtime inputs.",
  ].join("\n"),
};

export function buildSkillPrompt(skill: EmbeddedSkillName): string {
  return SKILL_PROMPTS[skill];
}
