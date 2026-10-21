export const SCHEMA_VERSION = 7;
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
  return { schemaVersion: SCHEMA_VERSION, systems: {}, knowledge: {} };
}

export function emptySystem() {
  return { properties: {}, categories: {}, components: {}, specialComponents: {}, recipeRules: {}, rules: {
    limitByCheck: false, successLimit: 0, outcomeLimits: {}, prioritySpecial: false, propertyOrder: []
  } };
}

export function emptyRecipeRules() {
  return { allowedPropertyIds: [], propertyOrder: [], limitByCheck: false, outcomeLimits: {}, prioritySpecial: false };
}

export function validateRecipeRules(system, rules, version = SCHEMA_VERSION) {
  const fields = Object.keys(emptyRecipeRules());
  assertFields(rules, [...fields, ...(version >= 7 ? ['outcomeStrengths'] : [])]);
  if (fields.some(key => !Object.hasOwn(rules, key))) throw new Error('Missing required field');
  references(system, rules.allowedPropertyIds);
  references(system, rules.propertyOrder);
  if (rules.propertyOrder.some(id => !rules.allowedPropertyIds.includes(id))) throw new Error('Order requires an allowed property');
  if (typeof rules.limitByCheck !== 'boolean' || typeof rules.prioritySpecial !== 'boolean') throw new Error('Rule toggles must be boolean');
  record(rules.outcomeLimits);
  for (const value of Object.values(rules.outcomeLimits)) limit(value);
  if (Object.hasOwn(rules, 'outcomeStrengths')) {
    record(rules.outcomeStrengths);
    for (const value of Object.values(rules.outcomeStrengths)) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error('Strength must be a positive finite number');
    }
  }
  return rules;
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

function properties(values, version = 1) {
  record(values);
  for (const property of Object.values(values)) {
    assertFields(property, ["name", "description", ...(version >= 6 ? ['essenceId'] : [])]);
    if (Object.hasOwn(property, 'essenceId')) assertKey(property.essenceId);
    if (typeof property.name !== "string" || !property.name.trim() || typeof property.description !== "string") {
      throw new Error("Property requires a non-empty name and string description");
    }
  }
}
function validateShape(data, version) {
  const legacy = version === 1;
  exactFields(data, legacy ? ["schemaVersion", "properties", "systems"] : version >= 4 ? ["schemaVersion", "systems", "knowledge"] : ["schemaVersion", "systems"]);
  if (data.schemaVersion !== version) throw new Error("Unsupported SkyBricate schema version");
  if (legacy) properties(data.properties);
  record(data.systems);
  for (const system of Object.values(data.systems)) {
    exactFields(system, legacy ? ["categories", "components", "rules"] : version === 2
      ? ["properties", "categories", "components", "rules"] : ["properties", "categories", "components", "specialComponents", "rules", ...(version >= 5 ? ['recipeRules'] : [])]);
    if (!legacy) properties(system.properties, version);
    const linked = Object.values(system.properties ?? {}).map(p => p.essenceId).filter(Boolean);
    if (new Set(linked).size !== linked.length) throw new Error('An essence can be linked to only one property per system');
    const catalog = legacy ? data : system;
    for (const assignments of [system.categories, system.components, ...(version >= 3 ? [system.specialComponents] : [])]) {
      record(assignments);
      for (const ids of Object.values(assignments)) references(catalog, ids);
    }
    if (version >= 3) for (const [id, special] of Object.entries(system.specialComponents)) {
      if (special.some(property => (system.components[id] ?? []).includes(property))) throw new Error("Duplicate assignment type");
    }
    const rules = system.rules;
    exactFields(rules, ["limitByCheck", "successLimit", "outcomeLimits", "prioritySpecial", "propertyOrder"]);
    if (typeof rules.limitByCheck !== "boolean" || typeof rules.prioritySpecial !== "boolean") throw new Error("Rule toggles must be boolean");
    limit(rules.successLimit);
    record(rules.outcomeLimits);
    for (const value of Object.values(rules.outcomeLimits)) limit(value);
    references(catalog, rules.propertyOrder);
    if (version >= 5) {
      record(system.recipeRules);
      for (const recipeRules of Object.values(system.recipeRules)) validateRecipeRules(system, recipeRules, version);
    }
  }
  if (version >= 4) {
    record(data.knowledge);
    for (const systems of Object.values(data.knowledge)) {
      record(systems);
      for (const [systemId, components] of Object.entries(systems)) {
        record(components);
        const system = data.systems[systemId];
        if (!system) throw new Error('Unknown knowledge system');
        for (const [componentId, ids] of Object.entries(components)) {
          references(system, ids);
          const assigned = [...(system.components[componentId] ?? []), ...(system.specialComponents[componentId] ?? [])];
          if (ids.some(id => !assigned.includes(id))) throw new Error('Knowledge requires an assignment');
        }
      }
    }
  }
  return data;
}

// Old valid schemas are read losslessly; migration persists only on a successful write.
export function readData(stored) {
  if (![2, 3, 4, 5, 6].includes(stored?.schemaVersion)) return copy(validateData(stored));
  validateShape(stored, stored.schemaVersion);
  const data = copy(stored);
  data.schemaVersion = SCHEMA_VERSION;
  if (stored.schemaVersion === 2) for (const system of Object.values(data.systems)) system.specialComponents = {};
  if (stored.schemaVersion < 4) data.knowledge = {};
  if (stored.schemaVersion < 5) for (const system of Object.values(data.systems)) system.recipeRules = {};
  return validateData(data);
}

// Assignment/catalog mutation and knowledge cleanup share a single persisted write.
export function pruneKnowledge(data) {
  for (const [actorId, systems] of Object.entries(data.knowledge)) {
    for (const [systemId, components] of Object.entries(systems)) {
      const system = data.systems[systemId];
      for (const [componentId, ids] of Object.entries(components)) {
        const assigned = [...(system?.components[componentId] ?? []), ...(system?.specialComponents[componentId] ?? [])];
        components[componentId] = ids.filter(id => assigned.includes(id));
        if (!components[componentId].length) delete components[componentId];
      }
      if (!Object.keys(components).length) delete systems[systemId];
    }
    if (!Object.keys(systems).length) delete data.knowledge[actorId];
  }
}
