import { useCallback, useRef } from "react";

/**
 * Focus return for controlled Radix dialogs opened without a DialogTrigger. Radix only restores focus to its
 * own trigger, so without this, closing such a dialog leaves keyboard focus on <body>.
 * Call `remember` just before opening; pass `onCloseAutoFocus` to DialogContent.
 */
export function useReturnFocus() {
  const opener = useRef<HTMLElement | null>(null);
  const remember = useCallback(() => {
    opener.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
  }, []);
  const onCloseAutoFocus = useCallback((event: Event) => {
    const target = opener.current;
    opener.current = null;
    if (!target?.isConnected) return;
    event.preventDefault();
    target.focus();
  }, []);
  return { remember, onCloseAutoFocus };
}
