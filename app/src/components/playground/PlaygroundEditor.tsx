import { useId, useMemo } from "react";
import { Link } from "react-router-dom";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input, Select, Textarea } from "@/components/ui/input";
import type { PlaygroundModelInfo, PlaygroundProviderInfo, ReasoningEffort } from "../../api/playground";
import {
  messageId, parseToolsText, type EditorMessage, type PlaygroundDraftState, type PlaygroundTarget,
} from "./playground-model";

type Update = (change: (draft: PlaygroundDraftState) => PlaygroundDraftState) => void;

export function modelInfo(providers: readonly PlaygroundProviderInfo[] | undefined, target: PlaygroundTarget): { provider: PlaygroundProviderInfo | null; model: PlaygroundModelInfo | null } {
  const provider = providers?.find(item => item.id === target.provider) ?? null;
  return { provider, model: provider?.models.find(item => item.id === target.model) ?? null };
}

export function modelLabel(providers: readonly PlaygroundProviderInfo[] | undefined, target: PlaygroundTarget): string {
  return modelInfo(providers, target).model?.label ?? target.model;
}

/** The tightest temperature limit among the selected models; models that ignore temperature do not constrain it. */
export function effectiveMaxTemperature(providers: readonly PlaygroundProviderInfo[] | undefined, targets: readonly PlaygroundTarget[]): number {
  return Math.min(2, ...targets.map(target => {
    const { model } = modelInfo(providers, target);
    return model?.temperature ? model.maxTemperature : 2;
  }));
}

const sectionLabel = "rp-eyebrow";

export function ModelPicker({ id, label, target, providers, disabled, onChange, onRemove }: {
  id: string;
  label: string;
  target: PlaygroundTarget;
  providers: readonly PlaygroundProviderInfo[] | undefined;
  disabled?: boolean;
  onChange: (target: PlaygroundTarget) => void;
  onRemove?: () => void;
}) {
  const { provider } = modelInfo(providers, target);
  const known = providers?.some(item => item.id === target.provider && item.models.some(model => model.id === target.model));
  const hintId = `${id}-key`;
  const missingKey = provider && !provider.configured;
  const keyNote = provider ? keySourceNote(provider) : null;
  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="rp-field-label">{label}</label>
        {missingKey && <span className="text-[12px] leading-4 text-rp-danger">No key saved</span>}
      </div>
      <div className="mt-1.5 flex items-center gap-1.5">
        <Select
          id={id}
          value={`${target.provider}/${target.model}`}
          disabled={disabled}
          aria-describedby={missingKey || keyNote ? hintId : undefined}
          onChange={event => {
            const [nextProvider, ...rest] = event.target.value.split("/");
            onChange({ provider: nextProvider as PlaygroundTarget["provider"], model: rest.join("/") });
          }}
          className="h-9 text-[13px]"
        >
          {!known && <option value={`${target.provider}/${target.model}`}>{target.model}</option>}
          {providers?.map(group => (
            <optgroup key={group.id} label={`${group.label} · ${group.keySource === "env" ? "key from environment" : group.configured ? "key saved" : "no key"}`}>
              {group.models.map(model => (
                <option key={model.id} value={`${group.id}/${model.id}`}>{model.label}{group.configured ? "" : " (no key)"}</option>
              ))}
            </optgroup>
          ))}
        </Select>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            aria-label={`Remove ${label.toLowerCase()}`}
            className="flex size-9 shrink-0 items-center justify-center rounded-control border border-rp-line text-rp-ink-muted transition-colors duration-fast ease-out hover:bg-rp-row-hover hover:text-rp-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rp-blue"
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        )}
      </div>
      {missingKey ? (
        <p id={hintId} className="mt-1.5 text-[12px] leading-[18px] text-rp-ink-muted">
          Add a {provider.label} key in <Link to="/settings" className="font-medium text-rp-blue underline-offset-2 hover:underline">Settings</Link> to run this model.
        </p>
      ) : keyNote && (
        <p id={hintId} className="mt-1.5 truncate text-[12px] leading-[18px] text-rp-ink-muted" title={keyNote}>{keyNote}</p>
      )}
    </div>
  );
}

function keySourceNote(provider: PlaygroundProviderInfo): string | null {
  if (provider.keySource === "env") return provider.keyEnvVar ? `Using ${provider.keyEnvVar} from the environment` : `Using a ${provider.label} key from the environment`;
  if (provider.keySource === "store") return `Using the ${provider.label} key saved in Settings`;
  return null;
}

function MessageEditor({ message, index, count, onChange, onRemove, onMove }: {
  message: EditorMessage;
  index: number;
  count: number;
  onChange: (message: EditorMessage) => void;
  onRemove: () => void;
  onMove: (delta: -1 | 1) => void;
}) {
  const base = useId();
  const roleId = `${base}-role`, contentId = `${base}-content`;
  const position = `message ${index + 1}`;
  const iconButton = "flex size-8 items-center justify-center rounded-control text-rp-ink-muted transition-colors duration-fast ease-out hover:bg-rp-row-hover hover:text-rp-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rp-blue disabled:pointer-events-none disabled:opacity-40";
  return (
    <li className="rounded-sm border border-rp-line bg-rp-surface" data-playground-message={index}>
      <div className="flex items-center gap-2 border-b border-rp-line-muted px-2.5 py-1.5">
        {message.role === "tool" ? (
          <span className="min-w-0 truncate font-mono text-[11px] font-medium uppercase tracking-[0.1em] text-rp-ink-muted" title={message.toolCallId}>
            Tool result{message.name ? ` · ${message.name}` : ""}
          </span>
        ) : (
          <>
            <label htmlFor={roleId} className="sr-only">Role for {position}</label>
            <select
              id={roleId}
              value={message.role}
              onChange={event => onChange({ ...message, role: event.target.value as EditorMessage["role"], ...(event.target.value === "user" ? { toolCalls: undefined } : {}) })}
              className="rp-select h-7 cursor-pointer rounded-sm border border-transparent bg-transparent pl-1.5 pr-8 font-mono text-[11px] font-medium uppercase tracking-[0.1em] text-rp-ink hover:border-rp-line focus-visible:border-rp-blue focus-visible:outline-none"
            >
              <option value="user">User</option>
              <option value="assistant">Assistant</option>
            </select>
          </>
        )}
        <div className="ml-auto flex items-center">
          <button type="button" className={iconButton} disabled={index === 0} onClick={() => onMove(-1)} aria-label={`Move ${position} up`}><ArrowUp aria-hidden="true" className="size-3.5" /></button>
          <button type="button" className={iconButton} disabled={index === count - 1} onClick={() => onMove(1)} aria-label={`Move ${position} down`}><ArrowDown aria-hidden="true" className="size-3.5" /></button>
          <button type="button" className={iconButton} disabled={count === 1} onClick={onRemove} aria-label={`Remove ${position}`}><X aria-hidden="true" className="size-3.5" /></button>
        </div>
      </div>
      {message.toolCalls?.length ? (
        <ul aria-label={`Tool calls in ${position}`} className="space-y-1 border-b border-rp-line-muted px-3 py-2">
          {message.toolCalls.map(call => (
            <li key={call.id} className="break-all font-mono text-[12px] leading-[18px] text-rp-ink-soft">
              <span className="text-rp-blue">{call.name}</span>({JSON.stringify(call.arguments)})
            </li>
          ))}
        </ul>
      ) : null}
      <label htmlFor={contentId} className="sr-only">Content of {position}</label>
      <Textarea
        id={contentId}
        value={message.content}
        onChange={event => onChange({ ...message, content: event.target.value })}
        placeholder={message.role === "tool" ? "Tool result the model should read, e.g. {\"temperature_c\": 11}" : message.role === "assistant" ? "Assistant reply" : "Ask the model something"}
        spellCheck={message.role !== "tool"}
        className={cn("min-h-[72px] rounded-none border-0 text-[13px] leading-[20px] hover:border-0 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-rp-blue", message.role === "tool" && "font-mono text-[12px]")}
        rows={message.content.split("\n").length > 3 ? 6 : 3}
      />
    </li>
  );
}

export function PlaygroundEditor({ draft, update, providers, invalidField }: {
  draft: PlaygroundDraftState;
  update: Update;
  providers: readonly PlaygroundProviderInfo[] | undefined;
  invalidField: string | null;
}) {
  const base = useId();
  const toolsCheck = useMemo(() => draft.toolsEnabled ? parseToolsText(draft.toolsText) : null, [draft.toolsEnabled, draft.toolsText]);
  const selected = draft.targets.map(target => ({ target, ...modelInfo(providers, target) }));
  const ignoresTemperature = selected.filter(item => item.model && !item.model.temperature).map(item => item.model!.label);
  const supportsEffort = selected.some(item => item.model?.reasoningEffort);
  const maxTemperature = effectiveMaxTemperature(providers, draft.targets);

  const setMessages = (change: (messages: EditorMessage[]) => EditorMessage[]) => update(current => ({ ...current, messages: change(current.messages) }));
  const addMessage = () => setMessages(messages => {
    const last = messages[messages.length - 1];
    return [...messages, { id: messageId(), role: last?.role === "user" ? "assistant" : "user", content: "" }];
  });

  return (
    <div className="space-y-5">
      <section>
        <label htmlFor={`${base}-system-input`} className={sectionLabel}>System</label>
        <Textarea
          id={`${base}-system-input`}
          value={draft.system}
          onChange={event => update(current => ({ ...current, system: event.target.value }))}
          placeholder="Optional instructions for the model, e.g. You triage support tickets."
          className="mt-2 min-h-[64px] text-[13px] leading-[20px]"
          rows={draft.system.split("\n").length > 3 ? 6 : 3}
        />
      </section>

      <section aria-labelledby={`${base}-messages`}>
        <div className="flex items-center justify-between">
          <h3 id={`${base}-messages`} className={sectionLabel}>Messages</h3>
          <span className="text-[12px] text-rp-ink-muted">{draft.messages.length} {draft.messages.length === 1 ? "message" : "messages"}</span>
        </div>
        <ol className={cn("mt-2 space-y-2", invalidField === "messages" && "rounded-sm outline outline-1 outline-offset-2 outline-rp-danger")}>
          {draft.messages.map((message, index) => (
            <MessageEditor
              key={message.id}
              message={message}
              index={index}
              count={draft.messages.length}
              onChange={next => setMessages(messages => messages.map(item => item.id === message.id ? next : item))}
              onRemove={() => setMessages(messages => messages.filter(item => item.id !== message.id))}
              onMove={delta => setMessages(messages => {
                const next = [...messages];
                const target = index + delta;
                if (target < 0 || target >= next.length) return messages;
                [next[index], next[target]] = [next[target]!, next[index]!];
                return next;
              })}
            />
          ))}
        </ol>
        <button
          type="button"
          onClick={addMessage}
          className="mt-2 inline-flex h-8 items-center gap-1.5 rounded-control border border-dashed border-rp-line px-3 text-[12px] font-medium text-rp-ink-soft transition-colors duration-fast ease-out hover:border-rp-wash-border hover:bg-rp-wash hover:text-rp-blue focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rp-blue"
        >
          <Plus aria-hidden="true" className="size-3.5" /> Add message
        </button>
      </section>

      <section aria-labelledby={`${base}-params`}>
        <h3 id={`${base}-params`} className={sectionLabel}>Parameters</h3>
        <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div>
            <label htmlFor={`${base}-temperature`} className="rp-field-label">Temperature</label>
            <Input
              id={`${base}-temperature`}
              inputMode="decimal"
              value={draft.temperature}
              placeholder="Default"
              data-playground-field="temperature"
              aria-invalid={invalidField === "temperature" || undefined}
              aria-describedby={`${base}-temperature-hint`}
              onChange={event => update(current => ({ ...current, temperature: event.target.value }))}
              className="mt-1.5 font-mono text-[13px]"
            />
          </div>
          <div>
            <label htmlFor={`${base}-max-tokens`} className="rp-field-label">Max output tokens</label>
            <Input
              id={`${base}-max-tokens`}
              inputMode="numeric"
              value={draft.maxOutputTokens}
              data-playground-field="maxOutputTokens"
              aria-invalid={invalidField === "maxOutputTokens" || undefined}
              onChange={event => update(current => ({ ...current, maxOutputTokens: event.target.value }))}
              className="mt-1.5 font-mono text-[13px]"
            />
          </div>
          {supportsEffort && (
            <div>
              <label htmlFor={`${base}-effort`} className="rp-field-label">Reasoning effort</label>
              <Select
                id={`${base}-effort`}
                value={draft.reasoningEffort}
                onChange={event => update(current => ({ ...current, reasoningEffort: event.target.value as "" | ReasoningEffort }))}
                className="mt-1.5 text-[13px]"
              >
                <option value="">Default</option>
                <option value="minimal">Minimal</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </Select>
            </div>
          )}
        </div>
        <p id={`${base}-temperature-hint`} className="mt-1.5 text-[12px] leading-[18px] text-rp-ink-muted">
          {ignoresTemperature.length
            ? `${ignoresTemperature.join(", ")} ${ignoresTemperature.length === 1 ? "ignores" : "ignore"} temperature.`
            : `0 to ${maxTemperature}. Empty uses the model default.`}
          {supportsEffort && " Reasoning effort applies to GPT-5 models only."}
        </p>
      </section>

      <section aria-labelledby={`${base}-tools`}>
        <div className="flex items-center justify-between gap-3">
          <h3 id={`${base}-tools`} className={sectionLabel}>Tools</h3>
          <label className="inline-flex cursor-pointer items-center gap-2 text-[13px] text-rp-ink">
            <input
              type="checkbox"
              checked={draft.toolsEnabled}
              onChange={event => update(current => ({ ...current, toolsEnabled: event.target.checked }))}
              className="size-4 accent-[color:var(--rp-blue-solid)]"
            />
            Send tool definitions
          </label>
        </div>
        {draft.toolsEnabled && (
          <>
            <label htmlFor={`${base}-tools-input`} className="sr-only">Tool definitions (JSON)</label>
            <Textarea
              id={`${base}-tools-input`}
              value={draft.toolsText}
              spellCheck={false}
              data-playground-field="tools"
              aria-invalid={(toolsCheck && !toolsCheck.ok) || invalidField === "tools" || undefined}
              aria-describedby={`${base}-tools-status`}
              onChange={event => update(current => ({ ...current, toolsText: event.target.value }))}
              className="mt-2 min-h-[140px] font-mono text-[12px] leading-[18px]"
              rows={8}
            />
            <p id={`${base}-tools-status`} className={cn("mt-1.5 text-[12px] leading-[18px]", toolsCheck && !toolsCheck.ok ? "text-rp-danger" : "text-rp-ink-muted")}>
              {toolsCheck && !toolsCheck.ok
                ? toolsCheck.error
                : toolsCheck?.ok
                  ? toolsCheck.tools.length ? `${toolsCheck.tools.length} ${toolsCheck.tools.length === 1 ? "tool" : "tools"}: ${toolsCheck.tools.map(tool => tool.name).join(", ")}. The model may call them; you supply the results.` : "No tools listed."
                  : null}
            </p>
          </>
        )}
      </section>
    </div>
  );
}
