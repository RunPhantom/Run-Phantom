import { PromptWorkspace } from "../components/prompts/PromptWorkspace";
import { localPromptClient } from "../components/prompts/client";
export function PromptsPage() { return <PromptWorkspace client={localPromptClient} canEdit canDelete scopeLabel="Local workspace" />; }
