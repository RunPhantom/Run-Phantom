/**
 * Deterministic local tools for the support agent. Nothing here calls a network
 * service, so the same arguments always produce the same result or failure.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description: string; enum?: string[] }>;
    required: string[];
    additionalProperties: false;
  };
}

/** A tool failure the agent may recover from: the model sees the error and can continue. */
export class ToolError extends Error {
  constructor(readonly type: string, message: string) {
    super(message);
    this.name = "ToolError";
  }
}

/** A failure after which continuing is unsafe, so the agent run stops and fails. */
export class FatalToolError extends ToolError {
  constructor(type: string, message: string) {
    super(type, message);
    this.name = "FatalToolError";
  }
}

interface Order {
  id: string;
  customer: string;
  item: string;
  sku: string;
  totalUsd: number;
  status: "delivered" | "in_transit" | "lost_in_transit";
  orderedOn: string;
  deliveredOn: string | null;
  daysSinceDelivery: number | null;
  lossConfirmedOn?: string;
}

const ORDERS: Record<string, Order> = {
  A1001: { id: "A1001", customer: "Maya Chen", item: "Aero wireless headphones", sku: "HP-110", totalUsd: 89, status: "delivered", orderedOn: "2026-11-10", deliveredOn: "2026-11-14", daysSinceDelivery: 11 },
  A1002: { id: "A1002", customer: "Jonas Weber", item: "Linea desk lamp", sku: "LM-040", totalUsd: 54.5, status: "in_transit", orderedOn: "2026-11-20", deliveredOn: null, daysSinceDelivery: null },
  A1003: { id: "A1003", customer: "Priya Nair", item: "Trail running shoes", sku: "SH-325", totalUsd: 132, status: "delivered", orderedOn: "2026-09-28", deliveredOn: "2026-10-02", daysSinceDelivery: 54 },
  A1004: { id: "A1004", customer: "Sam Okafor", item: "Aero wireless headphones", sku: "HP-110", totalUsd: 89, status: "delivered", orderedOn: "2026-03-02", deliveredOn: "2026-03-06", daysSinceDelivery: 264 },
  A1005: { id: "A1005", customer: "Lena Ortiz", item: "Studio monitor speakers", sku: "SP-900", totalUsd: 249, status: "lost_in_transit", orderedOn: "2026-11-03", deliveredOn: null, daysSinceDelivery: null, lossConfirmedOn: "2026-11-18" },
};

const INVENTORY: Record<string, { name: string; available: number; restockDate: string | null }> = {
  "HP-110": { name: "Aero wireless headphones", available: 42, restockDate: null },
  "LM-040": { name: "Linea desk lamp", available: 0, restockDate: "2026-12-09" },
  "SH-325": { name: "Trail running shoes", available: 7, restockDate: null },
  "SP-900": { name: "Studio monitor speakers", available: 3, restockDate: null },
  "KB-200": { name: "Lowprofile mechanical keyboard", available: 18, restockDate: null },
};

const KB_ARTICLES = [
  { id: "kb-refunds", title: "Refund policy", keywords: ["refund", "return", "money", "damaged", "broken", "cracked", "window"], body: "Delivered orders can be refunded in full within 30 days of delivery. Damaged items do not need to be sent back. Orders lost in transit are refunded in full once the carrier confirms the loss. After 30 days, offer warranty service instead of a refund." },
  { id: "kb-shipping", title: "Shipping times", keywords: ["shipping", "delivery", "transit", "late", "where", "track", "arrive"], body: "Standard shipping takes 3 to 6 business days. Orders in transit cannot be refunded until they are delivered or confirmed lost; customers may refuse delivery to start a return." },
  { id: "kb-warranty", title: "Hardware warranty", keywords: ["warranty", "repair", "charging", "battery", "defect", "stopped", "replace", "replacement"], body: "Electronics carry a 12-month limited warranty from the delivery date covering battery and charging faults. Approved claims receive a free replacement shipped within 2 business days. Claims need the order id and a short description of the fault." },
  { id: "kb-exchanges", title: "Exchanges", keywords: ["exchange", "swap", "different", "instead", "keyboard"], body: "Exchanges for a different product are processed as a refund plus a new order, subject to stock. Check inventory before promising an exchange." },
];

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "lookup_order",
    description: "Look up an order by id. Returns the item, SKU, total, delivery status and days since delivery.",
    parameters: { type: "object", properties: { order_id: { type: "string", description: "Order id such as A1001." } }, required: ["order_id"], additionalProperties: false },
  },
  {
    name: "check_inventory",
    description: "Check how many units of a SKU are available to ship.",
    parameters: { type: "object", properties: { sku: { type: "string", description: "Product SKU such as HP-110." } }, required: ["sku"], additionalProperties: false },
  },
  {
    name: "issue_refund",
    description: "Issue a refund to the original payment method. Only call this when the refund policy allows it.",
    parameters: {
      type: "object",
      properties: {
        order_id: { type: "string", description: "Order id to refund." },
        amount_usd: { type: "number", description: "Amount to refund in US dollars, at most the order total." },
        reason: { type: "string", description: "Short reason recorded on the refund.", enum: ["damaged", "lost_in_transit", "not_as_described", "changed_mind"] },
      },
      required: ["order_id", "amount_usd", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "search_kb",
    description: "Search the support knowledge base for policy articles.",
    parameters: { type: "object", properties: { query: { type: "string", description: "What to search for, for example 'refund window'." } }, required: ["query"], additionalProperties: false },
  },
];

export const DELEGATE_TOOL: ToolDefinition = {
  name: "delegate_research",
  description: "Ask the researcher agent to investigate a policy question in the knowledge base and report back a short, cited answer.",
  parameters: { type: "object", properties: { question: { type: "string", description: "The research question, with any order facts it needs." } }, required: ["question"], additionalProperties: false },
};

function stringArg(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) throw new ToolError("invalid_arguments", `Missing required string argument "${name}".`);
  return value.trim();
}

function normalizeOrderId(raw: string): string {
  return raw.toUpperCase().replace(/^#/, "");
}

export function lookupOrder(args: Record<string, unknown>) {
  const id = normalizeOrderId(stringArg(args, "order_id"));
  const order = ORDERS[id];
  if (!order) return { found: false, order_id: id, message: `No order ${id} exists.` };
  return {
    found: true, order_id: order.id, customer: order.customer, item: order.item, sku: order.sku, total_usd: order.totalUsd,
    status: order.status, ordered_on: order.orderedOn, delivered_on: order.deliveredOn, days_since_delivery: order.daysSinceDelivery,
    ...(order.lossConfirmedOn ? { carrier_confirmed_loss_on: order.lossConfirmedOn } : {}),
  };
}

export function checkInventory(args: Record<string, unknown>) {
  const sku = stringArg(args, "sku").toUpperCase();
  if (sku === "KB-200") {
    throw new ToolError("upstream_timeout", "Inventory service timed out after 5000 ms: warehouse eu-west-2 did not respond for SKU KB-200.");
  }
  const entry = INVENTORY[sku];
  if (!entry) return { sku, known: false, message: `Unknown SKU ${sku}.` };
  return { sku, known: true, name: entry.name, available: entry.available, restock_date: entry.restockDate };
}

export function issueRefund(args: Record<string, unknown>) {
  const id = normalizeOrderId(stringArg(args, "order_id"));
  const amount = args.amount_usd;
  const reason = stringArg(args, "reason");
  const order = ORDERS[id];
  if (!order) throw new ToolError("order_not_found", `Cannot refund ${id}: no such order.`);
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) {
    throw new ToolError("invalid_arguments", "amount_usd must be a positive number.");
  }
  if (amount > order.totalUsd) {
    throw new ToolError("amount_exceeds_total", `Cannot refund $${amount.toFixed(2)}: order ${id} totals $${order.totalUsd.toFixed(2)}.`);
  }
  if (order.status === "in_transit") {
    return { refunded: false, order_id: id, policy: "kb-shipping", message: "Order is still in transit; it can be refunded after delivery or a confirmed loss." };
  }
  if (order.daysSinceDelivery !== null && order.daysSinceDelivery > 30) {
    return { refunded: false, order_id: id, policy: "kb-refunds", message: `Delivered ${order.daysSinceDelivery} days ago, outside the 30-day refund window.` };
  }
  if (id === "A1005") {
    throw new FatalToolError(
      "ledger_write_conflict",
      "Payments ledger rejected refund rf_A1005 with a write conflict after the card network accepted it; the refund state is unknown and must be reconciled by a person before anything else is changed.",
    );
  }
  return { refunded: true, refund_id: `rf_${id}_${Math.round(amount * 100)}`, order_id: id, amount_usd: amount, reason, arrives_in: "3-5 business days" };
}

export function searchKb(args: Record<string, unknown>) {
  const query = stringArg(args, "query").toLowerCase();
  // Words under three letters ("a", "my", "is") prefix-match too many keywords to rank anything.
  const words = query.split(/[^a-z0-9]+/).filter((word) => word.length >= 3);
  const scored = KB_ARTICLES
    .map((article) => ({ article, score: words.filter((word) => article.keywords.some((keyword) => keyword.startsWith(word) || word.startsWith(keyword))).length }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);
  return {
    query,
    results: scored.map(({ article }) => ({ id: article.id, title: article.title, text: article.body })),
  };
}

export const LOCAL_TOOLS: Record<string, (args: Record<string, unknown>) => unknown> = {
  lookup_order: lookupOrder,
  check_inventory: checkInventory,
  issue_refund: issueRefund,
  search_kb: searchKb,
};
