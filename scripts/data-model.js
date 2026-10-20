export const SCHEMA_VERSION = 3;
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
  return { schemaVersion: SCHEMA_VERSION, systems: {} };
}

export function emptySystem() {
  return { properties: {}, categories: {}, components: {}, specialComponents: {}, rules: {
    limitByCheck: false, successLimit: 0, outcomeLimits: {}, prioritySpecial: false, propertyOrder: []
  } };
}

export function requireProperty(system, id) {
  assertKey(id);
  if (!Object.hasOwn(system?.properties ?? {}, id)) throw new Error(`Unknown property: ${id}`);
}

function references(system, values) {
  if (!Array.isArray(values)) throw new Error("Property references must be an array");
  for (const id of values) requireProperty(system, id);
  if (new Set(values).size !== values.length) throw new Error("Duplicate property reference");
}

function limit(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Limit must be a non-negative safe integer");
}

// Validate without normalization: corrupt/future data must never be silently reset.
export function validateData(data) { return validateShape(data, SCHEMA_VERSION); }

// Strict recognition is only for an explicit, confirmed deletion of old test data.
// It does not convert or normalize the old catalog.
export function validateLegacyData(data) { return validateShape(data, 1); }

function properties(values) {
  record(values);
  for (const property of Object.values(values)) {
    exactFields(property, ["name", "description"]);
    if (typeof property.name !== "string" || !property.name.trim() || typeof property.description !== "string") {
      throw new Error("Property requires a non-empty name and string description");
    }
  }
}
function validateShape(data, version) {
  const legacy = version === 1;
  exactFields(data, legacy ? ["schemaVersion", "properties", "systems"] : ["schemaVersion", "systems"]);
  if (data.schemaVersion !== version) throw new Error("Unsupported SkyBricate schema version");
  if (legacy) properties(data.properties);
  record(data.systems);
  for (const system of Object.values(data.systems)) {
    exactFields(system, legacy ? ["categories", "components", "rules"] : version === 2
      ? ["properties", "categories", "components", "rules"] : ["properties", "categories", "components", "specialComponents", "rules"]);
    if (!legacy) properties(system.properties);
    const catalog = legacy ? data : system;
    for (const assignments of [system.categories, system.components, ...(version === 3 ? [system.specialComponents] : [])]) {
      record(assignments);
      for (const ids of Object.values(assignments)) references(catalog, ids);
    }
    if (version === 3) for (const [id, special] of Object.entries(system.specialComponents)) {
      if (special.some(property => (system.components[id] ?? []).includes(property))) throw new Error("Duplicate assignment type");
    }
    const rules = system.rules;
    exactFields(rules, ["limitByCheck", "successLimit", "outcomeLimits", "prioritySpecial", "propertyOrder"]);
    if (typeof rules.limitByCheck !== "boolean" || typeof rules.prioritySpecial !== "boolean") throw new Error("Rule toggles must be boolean");
    limit(rules.successLimit);
    record(rules.outcomeLimits);
    for (const value of Object.values(rules.outcomeLimits)) limit(value);
    references(catalog, rules.propertyOrder);
  }
  return data;
}

// Schema 2 is read losslessly as ordinary links; schema 3 is persisted only on a successful write.
export function readData(stored) {
  if (stored?.schemaVersion !== 2) return copy(validateData(stored));
  validateShape(stored, 2);
  const data = copy(stored);
  data.schemaVersion = SCHEMA_VERSION;
  for (const system of Object.values(data.systems)) system.specialComponents = {};
  return validateData(data);
}
