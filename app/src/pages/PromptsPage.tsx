import { PromptWorkspace } from "../components/prompts/PromptWorkspace";
import { localPromptClient } from "../components/prompts/client";
import { EvaluationNavigation } from "../components/evaluations/EvaluationNavigation";
export function PromptsPage() { return <><EvaluationNavigation active="prompts" /><PromptWorkspace client={localPromptClient} canEdit canDelete scopeLabel="Local workspace" /></>; }
