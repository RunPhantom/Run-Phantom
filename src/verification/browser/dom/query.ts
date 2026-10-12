import { normalizeSemanticText, type SemanticQuery, type SemanticCoverage } from "../../protocol.js";
export type { SemanticCoverage } from "../../protocol.js";
import { isFrame, isInput, isSelect, isTextArea } from "./realm.js";

export const SEMANTIC_LIMITS = { nodes: 10_000, depth: 64, summaries: 100, text: 1024, name: 240, bytes: 32 * 1024 } as const;
interface TextReading { value: string; truncated: boolean }
interface CollectedElement { element: Element; depth: number; text: TextReading; visible: boolean }
export interface SemanticElement {
  element: Element;
  depth: number;
  role: string;
  name: string;
  label: string;
  testId: string;
  nameTruncated: boolean;
  disabled: boolean;
  readonly: boolean;
}
export interface SemanticCollection { elements: SemanticElement[]; coverage: SemanticCoverage }

const contentRoles = new Set(["button", "link", "heading", "checkbox", "radio", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "option", "treeitem", "switch", "tooltip", "cell", "gridcell", "rowheader", "columnheader", "listitem"]);
const skipTags = new Set(["script", "style", "template", "noscript"]);
const implicit: Record<string, string> = { button: "button", textarea: "textbox", nav: "navigation", main: "main", aside: "complementary", dialog: "dialog", ul: "list", ol: "list", li: "listitem", table: "table", tr: "row", tbody: "rowgroup", thead: "rowgroup", tfoot: "rowgroup", td: "cell", option: "option", optgroup: "group", progress: "progressbar", meter: "meter", summary: "button" };

function privateElement(element: Element): boolean { return element.hasAttribute("data-runphantom-private"); }
function styleVisible(element: Element): boolean {
  if (element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true" || privateElement(element)) return false;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  return !!style && style.display !== "none" && style.visibility === "visible" && style.contentVisibility !== "hidden" && style.opacity !== "0";
}

export function composedAncestors(element: Element): Element[] {
  const out: Element[] = [];
  let current: Element | null = element;
  for (let depth = 0; current && depth < SEMANTIC_LIMITS.depth; depth++) {
    out.push(current);
    if (current.parentElement) current = current.parentElement;
    else {
      const root = current.getRootNode();
      if (root.nodeType === 11 && "host" in root) current = (root as ShadowRoot).host;
      else current = current.ownerDocument.defaultView?.frameElement ?? null;
    }
  }
  if (current) throw new Error("Semantic ancestor depth exceeded its bound");
  return out;
}

export function isSemanticVisible(element: Element): boolean {
  try { return element.isConnected && Array.from(element.getClientRects()).some(rect => rect.width > 0 && rect.height > 0)
    && composedAncestors(element).every(ancestor => styleVisible(ancestor) && (!isFrame(ancestor) || Array.from(ancestor.getClientRects()).some(rect => rect.width > 0 && rect.height > 0))); }
  catch { return false; }
}

export function semanticRole(element: Element): string {
  const rawRole = element.getAttribute("role") ?? "";
  if (rawRole.length > 64) return "";
  const explicit = normalizeSemanticText(rawRole).split(" ")[0];
  if (/^[a-z][a-z0-9-]{0,63}$/.test(explicit)) return explicit;
  const tag = element.localName;
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (isInput(element)) {
    if (["button", "submit", "reset", "image"].includes(element.type)) return "button";
    if (element.type === "checkbox" || element.type === "radio") return element.type;
    if (element.type === "search") return "searchbox";
    if (element.type === "range") return "slider";
    if (element.type === "number") return "spinbutton";
    return ["hidden", "password", "color", "date", "file"].includes(element.type) ? "" : "textbox";
  }
  if (isSelect(element)) return element.multiple || element.size > 1 ? "listbox" : "combobox";
  if (tag === "a") return element.hasAttribute("href") ? "link" : "";
  if (tag === "img") return element.getAttribute("alt") === "" ? "" : "img";
  if (tag === "th") return ["row", "rowgroup"].includes(element.getAttribute("scope") ?? "") ? "rowheader" : "columnheader";
  if (tag === "section") return element.hasAttribute("aria-label") || element.hasAttribute("aria-labelledby") ? "region" : "";
  return implicit[tag] ?? "";
}

function appendText(target: TextReading, value: string, truncated = false): void {
  if (target.truncated) return;
  const room = SEMANTIC_LIMITS.text - target.value.length;
  const separator = target.value ? " " : "";
  if (truncated || value.length + separator.length > room) { target.value = ""; target.truncated = true; return; }
  if (value) target.value += separator + value;
}
function attribute(element: Element, name: string): TextReading {
  const value = element.getAttribute(name) ?? "";
  return value.length > SEMANTIC_LIMITS.text ? { value: "", truncated: true } : { value, truncated: false };
}
function unread(coverage: SemanticCoverage, element: Element | null, reason: string): void {
  coverage.complete = false; coverage.truncated = true;
  if (!coverage.reasons.includes(reason)) coverage.reasons.push(reason);
  if (coverage.unread.length < 16) coverage.unread.push({ tag: element?.localName ?? "document", reason });
  else coverage.unreadOverflow = true;
}

interface Frame { node: Node; depth: number; inherited: boolean; entered: boolean; next: ChildNode | null; extras: Node[]; extra: number; parent?: CollectedElement; own?: CollectedElement }

/** Bounded native observation. Names below deliberately approximate a subset of ARIA. */
export function collectSemanticElements(document: Document): SemanticCollection {
  const coverage: SemanticCoverage = { scope: "visible-observable-dom", complete: true, visitedNodes: 0, openShadowRoots: 0, sameOriginFrames: 0, inaccessibleFrames: 0, closedShadowRoots: "unobservable", hiddenSubtrees: 0, privateSubtrees: 0, truncated: false, reasons: [], unread: [] };
  const collected: CollectedElement[] = [];
  const readings = new Map<Element, TextReading>();
  const stack: Frame[] = [{ node: document, depth: 0, inherited: true, entered: false, next: null, extras: [], extra: 0 }];
  while (stack.length) {
    const frame = stack[stack.length - 1];
    if (!frame.entered) {
      if (coverage.visitedNodes >= SEMANTIC_LIMITS.nodes) { unread(coverage, frame.node.nodeType === 1 ? frame.node as Element : null, "node-limit"); break; }
      coverage.visitedNodes++; frame.entered = true;
      if (frame.depth > SEMANTIC_LIMITS.depth) { unread(coverage, frame.node.nodeType === 1 ? frame.node as Element : null, "depth-limit"); stack.pop(); continue; }
      if (frame.node.nodeType === 3) {
        if (frame.parent && frame.inherited) appendText(frame.parent.text, frame.node.nodeValue ?? "");
        stack.pop(); continue;
      }
      if (frame.node.nodeType === 1) {
        const element = frame.node as Element;
        if (skipTags.has(element.localName)) { stack.pop(); continue; }
        if (privateElement(element)) { coverage.privateSubtrees++; stack.pop(); continue; }
        let visible = frame.inherited;
        try { visible &&= styleVisible(element); } catch { unread(coverage, element, "visibility-unavailable"); visible = false; }
        if (!visible) { coverage.hiddenSubtrees++; stack.pop(); continue; }
        const own = { element, depth: frame.depth, visible: true, text: { value: "", truncated: false } };
        frame.own = own; collected.push(own); readings.set(element, own.text);
        if (element.localName === "img") { const alt = attribute(element, "alt"); appendText(own.text, alt.value, alt.truncated); }
        if (element.shadowRoot) { frame.extras.push(element.shadowRoot); coverage.openShadowRoots++; }
        if (isFrame(element)) {
          let child: Document | null = null;
          try { child = element.contentDocument; } catch { /* Inaccessible roots are declared below. */ }
          if (child?.documentElement && child.defaultView?.frameElement === element) { frame.extras.push(child); coverage.sameOriginFrames++; }
          else { coverage.inaccessibleFrames++; unread(coverage, element, "inaccessible-frame"); }
        }
        // Form values and editable document models are private; only their declared labels are read.
        if (isInput(element) || isTextArea(element) || isSelect(element) || element.hasAttribute("contenteditable")) frame.next = null;
        else frame.next = element.firstChild;
      } else frame.next = frame.node.firstChild;
    }
    const next = frame.next;
    if (next) {
      frame.next = next.nextSibling;
      stack.push({ node: next, depth: frame.depth + 1, inherited: frame.inherited, entered: false, next: null, extras: [], extra: 0, parent: frame.own ?? frame.parent });
      continue;
    }
    const extra = frame.extras[frame.extra++];
    if (extra) { stack.push({ node: extra, depth: frame.depth + 1, inherited: frame.inherited, entered: false, next: null, extras: [], extra: 0, parent: frame.own ?? frame.parent }); continue; }
    if (frame.own && frame.parent) appendText(frame.parent.text, frame.own.text.value, frame.own.text.truncated);
    stack.pop();
  }
  const elements = collected.flatMap((entry): SemanticElement[] => {
    const element = entry.element;
    if (!isSemanticVisible(element)) return [];
    if ((element.getAttribute("role")?.length ?? 0) > 64) unread(coverage, element, "role-limit");
    const role = semanticRole(element);
    const normalize = (value: string) => normalizeSemanticText(value);
    const labelText: TextReading = { value: "", truncated: false };
    if (isInput(element) || isTextArea(element) || isSelect(element)) {
      const labels = element.labels;
      if ((labels?.length ?? 0) > 16) labelText.truncated = true;
      for (let index = 0; labels && index < Math.min(labels.length, 16); index++) {
        const label = labels[index];
        const text = readings.get(label);
        if (text) appendText(labelText, text.value, text.truncated);
      }
    }
    const linked: TextReading = { value: "", truncated: false };
    const linkedAttribute = attribute(element, "aria-labelledby");
    const ids = linkedAttribute.value.split(/\s+/u).filter(Boolean);
    if (ids.length > 16 || linkedAttribute.truncated) linked.truncated = true;
    const root = element.getRootNode() as Document | ShadowRoot;
    for (const id of ids.slice(0, 16)) {
      const label = root.getElementById?.(id);
      const text = label ? readings.get(label) : undefined;
      if (text) appendText(linked, text.value, text.truncated);
    }
    const aria = attribute(element, "aria-label");
    const title = attribute(element, "title");
    const placeholder = (isInput(element) || isTextArea(element)) ? attribute(element, "placeholder") : { value: "", truncated: false };
    const alt = role === "img" ? attribute(element, "alt") : { value: "", truncated: false };
    const label = normalize(aria.value || linked.value || labelText.value);
    const content = contentRoles.has(role) ? entry.text.value : "";
    const name = normalize(label || (role === "img" ? alt.value : content) || title.value || placeholder.value);
    const testIdAttribute = attribute(element, "data-testid");
    const testId = normalize(testIdAttribute.value);
    const nameTruncated = name.length > SEMANTIC_LIMITS.text || aria.truncated || linked.truncated || labelText.truncated || title.truncated || placeholder.truncated || alt.truncated
      || contentRoles.has(role) && entry.text.truncated || testIdAttribute.truncated;
    if (nameTruncated) unread(coverage, element, "name-limit");
    if (!role && !name && !testId) return [];
    return [{ element, depth: entry.depth, role, name: name.slice(0, SEMANTIC_LIMITS.text), label: label.slice(0, SEMANTIC_LIMITS.text), testId: testId.slice(0, SEMANTIC_LIMITS.text), nameTruncated,
      disabled: element.matches(":disabled") || element.getAttribute("aria-disabled") === "true", readonly: (isInput(element) || isTextArea(element)) && element.readOnly }];
  });
  return { elements, coverage };
}

export function matchesSemanticQuery(element: SemanticElement, query: SemanticQuery): boolean {
  const match = (value: string, wanted: string) => query.kind === "test-id" || query.exact !== false
    ? normalizeSemanticText(value) === normalizeSemanticText(wanted)
    : normalizeSemanticText(value).includes(normalizeSemanticText(wanted));
  switch (query.kind) {
    case "role": return element.role === query.role && (query.name === undefined || !element.nameTruncated && match(element.name, query.name));
    case "name": return !element.nameTruncated && match(element.name, query.name);
    case "label": return !element.nameTruncated && !!element.label && match(element.label, query.label);
    case "test-id": return !element.nameTruncated && match(element.testId, query.testId);
    default: throw new Error("Unsupported semantic query strategy");
  }
}
