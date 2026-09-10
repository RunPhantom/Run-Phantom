import { useEffect, useId, useRef, useState } from "react";
import { Eye, EyeOff, Trash2 } from "lucide-react";
import { C } from "../utils/colors";

export function SecretInput({
  label,
  description,
  placeholder,
  value,
  onChange,
  onSave,
  onClear,
  saved,
  sourceIsEnv = false,
  saving,
  getKeyUrl,
  getKeyLabel,
}: {
  label: string;
  description?: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  onSave?: (value: string) => void;
  onClear?: () => void | Promise<void>;
  saved: boolean;
  /** True when the value came from an environment variable, not the local store. */
  sourceIsEnv?: boolean;
  saving?: boolean;
  /** External console where the user can generate this key. Renders a small link next to the description. */
  getKeyUrl?: string;
  /** Override link label. Defaults to "Get a key →". */
  getKeyLabel?: string;
}) {
  const inputId = useId();
  const descriptionId = `${inputId}-description`;
  const statusId = `${inputId}-status`;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [show, setShow] = useState(false);
  const [focused, setFocused] = useState(false);
  const canReveal = value.length > 0;
  const canSave = value.trim().length > 0 && !!onSave;
  const canClear = saved && value.trim().length === 0 && !!onClear;
  const showSave = canSave;
  const displayPlaceholder = saved && value.length === 0
    ? focused ? "" : "********"
    : placeholder;
  useEffect(() => {
    if (value.length === 0) setShow(false);
  }, [value]);
  const saveAndExitEditMode = () => {
    if (!canSave) return;
    setFocused(false);
    inputRef.current?.blur();
    onSave?.(value);
  };
  const clearSavedKey = () => {
    if (!canClear || saving) return;
    setFocused(false);
    inputRef.current?.blur();
    onClear?.();
  };
  const describedBy = [
    description || getKeyUrl || showSave ? descriptionId : null,
    saved ? statusId : null,
  ]
    .filter(Boolean)
    .join(" ") || undefined;
  return (
    <div className="py-1">
      <div className="mb-1.5 flex items-center justify-between gap-3">
        <label className="text-[12px] font-medium" style={{ color: C.fg3 }} htmlFor={inputId}>
          {label}
        </label>
        {saved && (
          // "saved" used to mean "configured", which is also true for a key the
          // daemon read from the environment — so the pane claimed the user had
          // saved a key they never entered, and the Clear button beside it did
          // nothing. Name the actual source.
          <span
            id={statusId}
            aria-live="polite"
            className="rounded-full px-2 py-1 text-[10px] font-mono"
            style={sourceIsEnv
              ? { color: C.fg1, background: "var(--rp-ink-wash)" }
              : { color: C.green, background: "color-mix(in srgb, var(--rp-success) 12%, white 88%)" }}
          >
            {sourceIsEnv ? "from env" : "saved"}
          </span>
        )}
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          id={inputId}
          ref={inputRef}
          aria-describedby={describedBy}
          className={`min-h-[44px] min-w-0 flex-1 rounded-xl px-3 py-2 text-[12px] font-mono outline-none transition-colors ${saved ? "secret-input-saved" : ""}`}
          style={{
            background: C.surface,
            color: C.fg3,
            border: `1px solid ${C.border}`,
            boxShadow: focused ? `0 0 0 1px ${C.accent}` : "none",
          }}
          type={show ? "text" : "password"}
          placeholder={displayPlaceholder}
          value={value}
          onPointerDown={() => {
            if (saved && value.length === 0) setFocused(true);
          }}
          onFocus={() => setFocused(true)}
          onChange={e => onChange(e.target.value)}
          onBlur={() => {
            setFocused(false);
          }}
          onKeyDown={e => {
            if (e.key === "Enter") {
              if (canSave) saveAndExitEditMode();
              else if (canClear) clearSavedKey();
              else e.currentTarget.blur();
            }
          }}
        />
        {canReveal && (
          <button
            type="button"
            aria-label={show ? `Hide ${label} value` : `Show ${label} value`}
            className="min-h-[44px] rounded-xl px-3 py-2 transition-colors rp-hover-wash sm:flex-shrink-0"
            style={{ background: C.elevated, border: `1px solid ${C.border}`, color: C.fg1 }}
            onMouseDown={e => e.preventDefault()}
            onClick={() => setShow(!show)}
            title={show ? `Hide ${label} value` : `Show ${label} value`}
          >
            {show ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
          </button>
        )}
        {canClear && (
          <button
            type="button"
            aria-label={`Clear saved ${label} key`}
            className="min-h-[44px] rounded-xl px-3 py-2 transition-colors rp-hover-wash sm:flex-shrink-0"
            style={{
              background: C.elevated,
              border: `1px solid ${C.border}`,
              color: saving ? C.fg0 : C.red,
              cursor: saving ? "default" : "pointer",
            }}
            onMouseDown={e => e.preventDefault()}
            onClick={clearSavedKey}
            disabled={saving}
            title="Clear saved key"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        )}
      </div>
      {(description || getKeyUrl || showSave) && (
        <div className="mt-1.5 flex flex-col gap-2 sm:flex-row sm:items-baseline sm:justify-between">
          <div className="flex min-w-0 items-center gap-2">
            {description && (
              <div id={descriptionId} className="text-[11px] leading-relaxed" style={{ color: C.fg0 }}>
                {description}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            {showSave ? (
              <button
                type="button"
                aria-label={`Save ${label} key`}
                className="min-h-[36px] whitespace-nowrap rounded-full px-3 py-1 text-[10px] font-mono transition-colors rp-hover-wash"
                style={{
                  color: saving || !canSave ? C.fg0 : C.green,
                  background: saving || !canSave ? C.elevated : "color-mix(in srgb, var(--rp-success) 12%, white 88%)",
                  border: `1px solid ${saving || !canSave ? C.border : "color-mix(in srgb, var(--rp-success) 22%, white 78%)"}`,
                  cursor: saving || !canSave ? "default" : "pointer",
                }}
                onClick={saveAndExitEditMode}
                disabled={saving || !canSave}
              >
                {saving ? "saving..." : "Save"}
              </button>
            ) : getKeyUrl && (
              <a
                href={getKeyUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="rp-touch-target text-[11px] font-medium whitespace-nowrap hover:underline"
                style={{ color: C.fg3 }}
              >
                {getKeyLabel ?? "Get a key \u2192"}
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
