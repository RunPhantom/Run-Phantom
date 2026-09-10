import { providerLabel, type AgentProviderId } from "../utils/agent-provider";
import type { AgentLoadout } from "../api/chat";

export interface SlashItem {
  label: string;
  value: string;
  description?: string;
}

export function buildSlashItems(loadout: AgentLoadout | null, draft: string, provider: AgentProviderId): SlashItem[] {
  const query = draft.startsWith("/") ? draft.slice(1).trim().toLowerCase() : "";
  const matches = (item: SlashItem) => {
    if (!query) return true;
    return [item.label, item.value, item.description ?? ""]
      .some((value) => value.toLowerCase().includes(query));
  };
  const label = providerLabel(provider);
  const commands: SlashItem[] = [
    { label: "New chat", value: "/new", description: `Start a fresh ${label} session` },
  ].filter(matches);
  const skills = (loadout?.skills ?? [])
    .map((skill): SlashItem => ({
      label: skill,
      value: `/${skill} `,
      description: `Use ${label} skill`,
    }))
    .filter(matches)
    .slice(0, 12);
  const slash = (loadout?.slash_commands ?? [])
    .map((cmd): SlashItem => ({
      label: cmd,
      value: cmd.startsWith("/") ? `${cmd} ` : `/${cmd} `,
      description: `${label} command`,
    }))
    .filter(matches);
  // A name can appear in both skills and slash_commands, which produced two
  // identical rows sharing the same React key (`value`-`label`). Keep the first
  // occurrence so the more specific group wins.
  const seen = new Set<string>();
  const unique: SlashItem[] = [];
  for (const item of [...commands, ...skills, ...slash]) {
    if (seen.has(item.value)) continue;
    seen.add(item.value);
    unique.push(item);
  }
  return unique.slice(0, 50);
}
