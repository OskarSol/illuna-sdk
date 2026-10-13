export type Value = string | number | boolean;
export type ValueType = "string" | "number" | "boolean";
export interface ElementDefinition {
  pages: readonly string[];
  description: string;
  valueType: ValueType;
  defaultValue: Value;
  label?: string;
  category?: string;
  constraints?: {
    allowedValues?: readonly Value[];
    maxLength?: number;
    min?: number;
    max?: number;
  };
}
export type Elements = Readonly<Record<string, ElementDefinition>>;
export interface Snapshot { values: Record<string, Value>; revision: number; pageId: string }
export interface AdaptResult extends Snapshot {
  message: string;
  applied: Array<{ id: string; previousValue: Value; value: Value }>;
}
export class IllunaError extends Error {
  constructor(public code: string, message: string, public status = 400) {
    super(message);
    this.name = "IllunaError";
  }
}
export const LIMITS = Object.freeze({ elements: 50, updates: 25, message: 1000, bodyBytes: 65536, text: 500 });
export function assertKey(key: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(key) || key.split(".").some(s => ["__proto__", "prototype", "constructor"].includes(s))) {
    throw new IllunaError("INVALID_KEY", `Invalid identifier: ${key}`);
  }
}
export function validateValue(def: ElementDefinition, value: unknown): asserts value is Value {
  if (typeof value !== def.valueType || (typeof value === "number" && !Number.isFinite(value))) {
    throw new IllunaError("INVALID_VALUE", `Expected ${def.valueType}`);
  }
  const c = def.constraints;
  if (c?.allowedValues && !c.allowedValues.includes(value as Value)) throw new IllunaError("INVALID_VALUE", "Value is outside the allowed values");
  if (typeof value === "string" && value.length > (c?.maxLength ?? LIMITS.text)) throw new IllunaError("INVALID_VALUE", "Text is too long");
  if (typeof value === "number" && ((c?.min !== undefined && value < c.min) || (c?.max !== undefined && value > c.max))) throw new IllunaError("INVALID_VALUE", "Number is outside the allowed range");
}
/** Define a stable catalog once, outside the React component tree. */
export function defineElements<const T extends Elements>(elements: T): T {
  for (const [key, def] of Object.entries(elements)) {
    assertKey(key);
    if (!Array.isArray(def.pages) || !def.pages.length || def.pages.length > 30) throw new IllunaError("INVALID_DEFINITION", `${key}: pages are required`);
    for (const page of def.pages) if (page !== "*") assertKey(page);
    if (!def.description?.trim() || def.description.length > 1000) throw new IllunaError("INVALID_DEFINITION", `${key}: a description is required (max 1000 characters)`);
    if (!["string", "number", "boolean"].includes(def.valueType)) throw new IllunaError("INVALID_DEFINITION", `${key}: unsupported type`);
    const c = def.constraints;
    if (c?.maxLength !== undefined && (!Number.isInteger(c.maxLength) || c.maxLength < 1 || c.maxLength > LIMITS.text)) throw new IllunaError("INVALID_DEFINITION", `${key}: invalid maxLength`);
    if (c?.min !== undefined && !Number.isFinite(c.min) || c?.max !== undefined && !Number.isFinite(c.max) || c?.min !== undefined && c?.max !== undefined && c.min > c.max) throw new IllunaError("INVALID_DEFINITION", `${key}: invalid numeric bounds`);
    if (c?.allowedValues && (!c.allowedValues.length || c.allowedValues.length > 50 || c.allowedValues.some(v => typeof v !== def.valueType))) throw new IllunaError("INVALID_DEFINITION", `${key}: invalid allowedValues`);
    validateValue(def, def.defaultValue);
  }
  return elements;
}
export function elementsForPage(elements: Elements, pageId: string): Elements {
  assertKey(pageId);
  if (!Object.values(elements).some(d => d.pages.includes(pageId))) throw new IllunaError("UNKNOWN_PAGE", "Unknown page");
  const scoped = Object.fromEntries(Object.entries(elements).filter(([, d]) => d.pages.includes(pageId) || d.pages.includes("*")));
  if (Object.keys(scoped).length > LIMITS.elements) throw new IllunaError("TOO_MANY_ELEMENTS", `At most ${LIMITS.elements} elements per page`);
  return scoped;
}
