import { useEffect, useId, useRef, useState } from "react";
import { ArrowUpRight, Eye, EyeOff, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fieldClassName } from "@/components/ui/input";

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
  /** Override link label. Defaults to "Get a key". */
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
    <div className="py-5">
      <div className="mb-2 flex items-center justify-between gap-3">
        <label className="text-[13px] font-medium text-rp-ink" htmlFor={inputId}>
          {label}
        </label>
        {saved && (
          // "saved" used to mean "configured", which is also true for a key the
          // daemon read from the environment — so the pane claimed the user had
          // saved a key they never entered, and the Clear button beside it did
          // nothing. Name the actual source.
          <Badge id={statusId} aria-live="polite" mono tone={sourceIsEnv ? "neutral" : "success"}>
            {sourceIsEnv ? "from env" : "saved"}
          </Badge>
        )}
      </div>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          id={inputId}
          ref={inputRef}
          aria-describedby={describedBy}
          className={cn(fieldClassName, "h-10 flex-1 font-mono text-[13px]", saved && "secret-input-saved")}
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
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={show ? `Hide ${label} value` : `Show ${label} value`}
            className="h-10 w-full sm:w-10 sm:flex-shrink-0"
            onMouseDown={e => e.preventDefault()}
            onClick={() => setShow(!show)}
            title={show ? `Hide ${label} value` : `Show ${label} value`}
          >
            {show ? <EyeOff aria-hidden="true" className="!size-3.5" /> : <Eye aria-hidden="true" className="!size-3.5" />}
          </Button>
        )}
        {canClear && (
          <Button
            type="button"
            variant="destructive-outline"
            size="icon"
            aria-label={`Clear saved ${label} key`}
            className="h-10 w-full sm:w-10 sm:flex-shrink-0"
            onMouseDown={e => e.preventDefault()}
            onClick={clearSavedKey}
            disabled={saving}
            title="Clear saved key"
          >
            <Trash2 aria-hidden="true" className="!size-3.5" />
          </Button>
        )}
      </div>
      {(description || getKeyUrl || showSave) && (
        <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-2">
            {description && (
              <div id={descriptionId} className="text-[12px] leading-5 text-rp-ink-muted">
                {description}
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            {showSave ? (
              <Button
                type="button"
                size="sm"
                aria-label={`Save ${label} key`}
                onClick={saveAndExitEditMode}
                disabled={saving || !canSave}
              >
                {saving ? "Saving…" : "Save"}
              </Button>
            ) : getKeyUrl && (
              <a
                href={getKeyUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="rp-touch-target rp-ease inline-flex items-center gap-1 whitespace-nowrap text-[12px] font-medium text-rp-blue hover:text-rp-blue-hover hover:underline hover:underline-offset-4"
              >
                {getKeyLabel ?? "Get a key"}
                <ArrowUpRight aria-hidden="true" className="size-3.5" />
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
