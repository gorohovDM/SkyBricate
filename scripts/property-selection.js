import { assertFields, assertKey, requireProperty } from './data-model.js';

function record(value) {
  // Reuse the storage contract's plain-record and safe-key validation.
  assertFields(value, Object.keys(value ?? {}));
}

function references(system, ids) {
  if (!Array.isArray(ids)) throw new Error('Property references must be an array');
  for (const id of ids) requireProperty(system, id);
  if (new Set(ids).size !== ids.length) throw new Error('Duplicate property reference');
}

const compareIds = (a, b) => a < b ? -1 : a > b ? 1 : 0;

/** Pure stage-7 selection. Rules are supplied by the caller for one recipe. */
export function selectProperties(input) {
  assertFields(input, ['componentIds', 'system', 'recipeRules', 'outcome']);
  const { componentIds, system, recipeRules = {}, outcome } = input;
  record(system);
  record(system.properties);
  record(system.components);
  record(system.specialComponents);
  for (const assignments of [system.components, system.specialComponents]) {
    for (const ids of Object.values(assignments)) references(system, ids);
  }
  for (const [id, special] of Object.entries(system.specialComponents)) {
    if (special.some(propertyId => (Object.hasOwn(system.components, id) ? system.components[id] : []).includes(propertyId))) {
      throw new Error('Duplicate assignment type');
    }
  }
  if (!Array.isArray(componentIds)) throw new Error('Component IDs must be an array');
  for (const id of componentIds) assertKey(id);
  assertFields(recipeRules, ['limitByCheck', 'outcomeLimits', 'prioritySpecial', 'propertyOrder', 'allowedPropertyIds', 'outcomeStrengths']);
  const { limitByCheck = false, outcomeLimits = {}, prioritySpecial = false, propertyOrder = [] } = recipeRules;
  if (typeof limitByCheck !== 'boolean' || typeof prioritySpecial !== 'boolean') throw new Error('Rule toggles must be boolean');
  record(outcomeLimits);
  for (const count of Object.values(outcomeLimits)) {
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('Limit must be a non-negative safe integer');
  }
  references(system, propertyOrder);
  const allowed = Object.hasOwn(recipeRules, 'allowedPropertyIds') ? new Set(recipeRules.allowedPropertyIds) : null;
  if (allowed) references(system, recipeRules.allowedPropertyIds);
  let maximum = Infinity;
  if (limitByCheck) {
    assertKey(outcome);
    if (!Object.hasOwn(outcomeLimits, outcome)) throw new Error('Missing property limit for check outcome');
    maximum = outcomeLimits[outcome];
  }

  const sources = new Map();
  for (const componentId of [...new Set(componentIds)].sort(compareIds)) {
    for (const [assignmentType, assignments] of [['ordinary', system.components], ['special', system.specialComponents]]) {
      const ids = Object.hasOwn(assignments, componentId) ? assignments[componentId] : [];
      for (const propertyId of ids) {
        if (!sources.has(propertyId)) sources.set(propertyId, []);
        sources.get(propertyId).push({ componentId, assignmentType });
      }
    }
  }
  const special = [], matched = [];
  for (const [propertyId, origins] of sources) {
    if (allowed && !allowed.has(propertyId)) continue;
    const specialSources = origins.filter(source => source.assignmentType === 'special');
    if (prioritySpecial && specialSources.length) {
      special.push({ propertyId, selectionType: 'special', sources: specialSources });
    } else if (origins.length >= 2) {
      matched.push({ propertyId, selectionType: 'matched', sources: origins });
    }
  }
  const rank = new Map(propertyOrder.map((id, index) => [id, index]));
  const order = (a, b) => (rank.get(a.propertyId) ?? Infinity) - (rank.get(b.propertyId) ?? Infinity)
    || compareIds(a.propertyId, b.propertyId);
  return [...special.sort(order), ...matched.sort(order)].slice(0, maximum);
}
