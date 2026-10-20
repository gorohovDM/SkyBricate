import { assertFields, assertKey, copy } from './data-model.js';
import { persistedSystems } from './assignment-contract.js';

const record = value => assertFields(value, Object.keys(value ?? {}));

// Stock SettingsCraftingDefinitionRepository, full saved corpus. Never UI projections.
export function persistedRecipes(game) {
  const systems = persistedSystems(game);
  const setting = game.settings.settings.get('fabricate.recipes');
  if (setting?.scope !== 'world' || setting.type !== Array) throw new Error('Unsupported persisted recipe contract');
  const rows = game.settings.get('fabricate', 'recipes');
  if (!Array.isArray(rows)) throw new Error('Incomplete persisted recipe corpus');
  const recipes = new Map();
  for (const recipe of rows) {
    record(recipe); assertKey(recipe.id); assertKey(recipe.craftingSystemId);
    if (recipes.has(recipe.id) || !systems.has(recipe.craftingSystemId) || typeof recipe.name !== 'string') {
      throw new Error('Invalid persisted recipe');
    }
    recipes.set(recipe.id, copy(recipe));
  }
  return recipes;
}

// Mirrors the active crafting slots in stock checkModifierResolver / CraftingEngine.
// pass/fail are native simple outcome IDs. Routed roll.outcome is a NAME, but the
// stable authored key is tier.id (roll.data.outcomeId); stage 9 must use that ID.
export function recipeOutcomes(system) {
  const mode = system.resolutionMode;
  const check = system.craftingCheck;
  const alchemy = mode === 'alchemy' ? system.alchemy?.checkMode ?? 'none' : null;
  if (mode === 'progressive' || alchemy === 'none') return [];
  // Fail closed on legacy formulas needing Fabricate's retirement shim. We do
  // not copy its parser into SkyBricate or assume such a formula still rolls.
  const usable = config => typeof config?.rollFormula === 'string' && !!config.rollFormula.trim()
    && !/@craftingmod\b/.test(config.rollFormula);
  if (['simple', 'routedByIngredients'].includes(mode) || alchemy === 'simple') {
    if (!usable(check?.simple)) return [];
    if (mode === 'simple' && check?.enabled !== true && system.features?.craftingChecks !== true) return [];
    return [{ id: 'fail', name: 'Failure', labelKey: 'Failure' }, { id: 'pass', name: 'Success', labelKey: 'Success' }];
  }
  if (mode === 'routedByCheck' || alchemy === 'tiered') {
    const routed = check?.routed;
    record(routed);
    if (!usable(routed)) return [];
    if (!['relative', 'fixed'].includes(routed.type)) throw new Error('Unsupported routed check type');
    const tiers = routed.type === 'fixed' ? routed.fixedOutcomes : routed.relativeOutcomes;
    if (!Array.isArray(tiers)) throw new Error('Missing native outcome tiers');
    const seen = new Set();
    return tiers.map(tier => {
      record(tier); assertKey(tier.id);
      if (seen.has(tier.id) || typeof tier.name !== 'string') throw new Error('Invalid native outcome tier');
      seen.add(tier.id); return { id: tier.id, name: tier.name };
    });
  }
  throw new Error('Unsupported crafting resolution mode');
}

export function recipeContext(game, systemId, recipeId) {
  assertKey(systemId); assertKey(recipeId);
  const recipe = persistedRecipes(game).get(recipeId);
  if (!recipe || recipe.craftingSystemId !== systemId) throw new Error('Recipe context is no longer available');
  const system = game.settings.get('fabricate', 'craftingSystems').find(row => row.id === systemId);
  const outcomes = recipeOutcomes(system);
  // The native saved recipe/check may change while our window is open. Reload
  // explicitly instead of applying a stale draft to a changed context.
  const revision = JSON.stringify([recipe, system.resolutionMode, system.alchemy, system.craftingCheck, system.features]);
  return { recipe, outcomes, revision };
}

export function validateOutcomeLimits(rules, outcomes) {
  if (!rules.limitByCheck) return;
  const ids = outcomes.map(row => row.id);
  if (!ids.length) throw new Error('This check has no stable named outcomes; disable the limit');
  if (ids.some(id => !Object.hasOwn(rules.outcomeLimits, id))
    || Object.keys(rules.outcomeLimits).some(id => !ids.includes(id))) {
    throw new Error('Configure a limit for every current native outcome');
  }
}
