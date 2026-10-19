export const SCHEMA_VERSION = 1;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
export const copy = value => structuredClone(value);

export function assertKey(key) {
  if (typeof key !== "string" || !key.trim() || FORBIDDEN_KEYS.has(key)) {
    throw new Error("Expected a non-empty, safe identifier");
  }
  return key;
}

function record(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error("Expected a plain record");
  for (const key of Object.keys(value)) assertKey(key);
  return value;
}

export function assertFields(value, fields) {
  record(value);
  for (const key of Object.keys(value)) if (!fields.includes(key)) throw new Error(`Unknown field: ${key}`);
}

function exactFields(value, fields) {
  assertFields(value, fields);
  if (fields.some(key => !Object.hasOwn(value, key))) throw new Error("Missing required field");
}

export function emptyData() {
  return { schemaVersion: SCHEMA_VERSION, properties: {}, systems: {} };
}

export function emptySystem() {
  return { categories: {}, components: {}, rules: {
    limitByCheck: false, successLimit: 0, outcomeLimits: {}, prioritySpecial: false, propertyOrder: []
  } };
}

export function requireProperty(data, id) {
  assertKey(id);
  if (!Object.hasOwn(data.properties, id)) throw new Error(`Unknown property: ${id}`);
}

function references(data, values) {
  if (!Array.isArray(values)) throw new Error("Property references must be an array");
  for (const id of values) requireProperty(data, id);
  if (new Set(values).size !== values.length) throw new Error("Duplicate property reference");
}

function limit(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Limit must be a non-negative safe integer");
}

// Validate without normalization: corrupt/future data must never be silently reset.
export function validateData(data) {
  exactFields(data, ["schemaVersion", "properties", "systems"]);
  if (data.schemaVersion !== SCHEMA_VERSION) throw new Error("Unsupported SkyBricate schema version");
  record(data.properties);
  for (const property of Object.values(data.properties)) {
    exactFields(property, ["name", "description"]);
    if (typeof property.name !== "string" || !property.name.trim() || typeof property.description !== "string") {
      throw new Error("Property requires a non-empty name and string description");
    }
  }
  record(data.systems);
  for (const system of Object.values(data.systems)) {
    exactFields(system, ["categories", "components", "rules"]);
    for (const assignments of [system.categories, system.components]) {
      record(assignments);
      for (const ids of Object.values(assignments)) references(data, ids);
    }
    const rules = system.rules;
    exactFields(rules, ["limitByCheck", "successLimit", "outcomeLimits", "prioritySpecial", "propertyOrder"]);
    if (typeof rules.limitByCheck !== "boolean" || typeof rules.prioritySpecial !== "boolean") throw new Error("Rule toggles must be boolean");
    limit(rules.successLimit);
    record(rules.outcomeLimits);
    for (const value of Object.values(rules.outcomeLimits)) limit(value);
    references(data, rules.propertyOrder);
  }
  return data;
}
