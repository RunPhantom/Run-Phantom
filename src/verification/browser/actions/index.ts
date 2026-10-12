import type { AppCommand, SemanticCommand } from "../../protocol.js";
import { sanitizeWithReport } from "../../serialization.js";
import { isHtmlElement, isInput, isTextArea } from "../dom/realm.js";
import { assertEditable, assertNotRichText, setNativeValue } from "./value-input.js";
import { composedAncestors, isSemanticVisible, semanticRole } from "../dom/query.js";
import { LiveElementRefs } from "../dom/refs.js";
import { findSemantic, snapshotSemantic } from "../dom/snapshot.js";

function matches(selector: string): NodeListOf<Element> {
  try { return document.querySelectorAll(selector); } catch {
    throw new Error("Invalid CSS selector");
  }
}
function actionTarget(selector: string): HTMLElement {
  const elements = matches(selector);
  if (!elements.length) throw new Error("Selector did not match an element");
  if (elements.length !== 1) throw new Error("Selector matched multiple elements; use a unique selector");
  const element = elements[0];
  if (!isHtmlElement(element)) throw new Error("Actions require an HTML element");
  if (element.matches(":disabled") || element.getAttribute("aria-disabled") === "true") {
    throw new Error("Cannot act on a disabled element");
  }
  if (element.closest("[inert]")) throw new Error("Cannot act on an inert element");
  const style = window.getComputedStyle(element);
  if (!element.getClientRects().length || style.visibility !== "visible" || style.display === "none") {
    throw new Error("Cannot act on a hidden element");
  }
  return element;
}

export function runDomCommand(
  command: Extract<AppCommand, { type: "snapshot" | "click" | "fill" }>,
  sanitize: (value: unknown) => { value: unknown; truncated: boolean } = (value) => {
    const safe = sanitizeWithReport(value);
    return { value: safe.value, truncated: Boolean(safe.truncation || safe.redacted) };
  },
  beforeMutation?: (element: Element) => void,
): { result: unknown; truncated?: boolean } {
  if (command.type === "snapshot") {
    const selector = command.selector ?? "button,input,textarea,select,a,[role]";
    const elements = matches(selector);
    // Selector assertions need only the count. Never read a form control's value or HTML markup.
    if (command.selector) {
      const safe = sanitize(selector);
      return { result: { selector: safe.value, count: elements.length }, truncated: safe.truncated };
    }
    let truncated = elements.length > 100;
    const summaries = Array.from(elements).slice(0, 100).map((element) => {
      const label = element.getAttribute("aria-label") ?? (isInput(element) || isTextArea(element) ? "" : element.textContent ?? "");
      // Redact the complete label before display truncation can cut a credential in half.
      const safe = sanitize(label);
      const safeLabel = typeof safe.value === "string" ? safe.value : "";
      const safeId = sanitize(element.id);
      const safeRole = sanitize(element.getAttribute("role"));
      if (safe.truncated || safeId.truncated || safeRole.truncated || safeLabel.length > 240) truncated = true;
      return {
        tag: element.tagName.toLowerCase(), id: safeId.value, role: safeRole.value,
        label: safeLabel.slice(0, 240), disabled: element.matches(":disabled") || element.getAttribute("aria-disabled") === "true",
      };
    });
    return { result: { selector, count: elements.length, elements: summaries }, truncated };
  }
  const element = actionTarget(command.selector);
  if (command.type === "click") {
    beforeMutation?.(element);
    element.click();
    return { result: { dispatched: true } };
  }
  assertNotRichText(element, "fill");
  if (!isInput(element) && !isTextArea(element)) throw new Error("Fill requires an input or textarea");
  if (isInput(element) && !["text", "search", "tel", "url", "email", "password", "number"].includes(element.type)) {
    throw new Error("This input type does not support text filling");
  }
  assertEditable(element, "fill");
  beforeMutation?.(element);
  element.focus();
  const prevented = setNativeValue(element, command.value);
  return { result: { dispatched: true, defaultPrevented: prevented } };
}

function semanticTarget(ref: string, refs: LiveElementRefs, fill: boolean): HTMLElement {
  const element = refs.resolve(ref);
  if (!isHtmlElement(element)) throw new Error("Actions require an HTML element");
  if (!isSemanticVisible(element)) throw new Error("Cannot act on a hidden element");
  if (composedAncestors(element).some(ancestor => ancestor.hasAttribute("inert") || ancestor.getAttribute("aria-disabled") === "true")
    || element.matches(":disabled")) throw new Error("Cannot act on a disabled or inert element");
  if ((isInput(element) || isTextArea(element)) && element.readOnly) throw new Error("Cannot act on a readonly element");
  if (fill) {
    assertNotRichText(element, "fill");
    if (!isInput(element) && !isTextArea(element)) throw new Error("Fill requires an input or textarea");
    if (isInput(element) && !["text", "search", "tel", "url", "email", "password", "number"].includes(element.type)) throw new Error("This input type does not support text filling");
    assertEditable(element, "fill");
  } else if (!["button", "link", "checkbox", "radio", "switch", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "option", "treeitem", "textbox", "searchbox", "spinbutton", "combobox", "listbox", "slider"].includes(semanticRole(element))) {
    throw new Error("Reference is not an interactive click target");
  }
  return element;
}

export function runSemanticDomCommand(
  command: SemanticCommand,
  refs: LiveElementRefs,
  sanitize: (value: unknown) => { value: unknown; truncated: boolean },
  beforeMutation: (element: Element) => void,
): { result: unknown; truncated?: boolean } {
  if (command.type === "find") return findSemantic(command.query, refs, sanitize);
  if (command.type === "semantic-snapshot") return snapshotSemantic(refs, sanitize);
  const element = semanticTarget(command.ref, refs, command.type === "ref-fill");
  // Resolve and validate before recording an action or invoking any page focus handler.
  beforeMutation(element);
  if (command.type === "ref-click") {
    element.click();
    return { result: { dispatched: true, source: "sdk-reported" } };
  }
  element.focus();
  if (semanticTarget(command.ref, refs, true) !== element) throw new Error("Reference changed during focus");
  const prevented = setNativeValue(element as HTMLInputElement | HTMLTextAreaElement, command.value);
  return { result: { dispatched: true, defaultPrevented: prevented, source: "sdk-reported" } };
}
