import { copy, assertKey } from './data-model.js';
import { selectProperties } from './property-selection.js';
import { recipeOutcomes, validateOutcomeLimits, outcomeStrength } from './recipe-contract.js';
import { installResultApplication } from './craft-application.js';
import { persistedSystems } from './assignment-contract.js';

// Private module context, never attached to Items, runs, chat, hooks or module.api.
// Every native invocation receives its own receiver, including concurrent crafts.
const attempts = new WeakMap();
const installed = new WeakMap();
export const getCraftAttempt = receiver => attempts.has(receiver) ? copy(attempts.get(receiver)) : null;

export function systemEssences(game, systemId) {
  if (!persistedSystems(game).has(systemId)) throw new Error('Unknown Fabricate system');
  const systems = game.settings.get('fabricate', 'craftingSystems');
  const system = Array.isArray(systems) && systems.find(row => row.id === systemId);
  const rows = system?.essenceDefinitions ?? [];
  if (!Array.isArray(rows)) throw new Error('Invalid essence definitions');
  const ids = new Set();
  return rows.map(row => {
    assertKey(row.id);
    if (ids.has(row.id)) throw new Error('Duplicate essence ID');
    ids.add(row.id);
    return { id: row.id, name: typeof row.name === 'string' ? row.name : row.id };
  });
}

const configured = (system, recipeId) => system && (Object.values(system.components).some(ids => ids.length)
  || Object.values(system.specialComponents).some(ids => ids.length) || Object.hasOwn(system.recipeRules, recipeId));
const failed = () => ({ success: false, results: null, disposition: 'skybricate-configuration',
  message: 'SkyBricate: crafting configuration is unavailable or unsupported; ask the GM.' });

function supported(engine, actor, recipe, system, options, fallbackRunManager) {
  const steps = recipe.getExecutionSteps?.() ?? [{ timeRequirement: recipe.timeRequirement }];
  const runManager = engine.craftingRunManager || fallbackRunManager;
  const run = options.runId ? runManager?.getActiveRun?.(actor, options.runId) : runManager?.findActiveRunForRecipe?.(actor, recipe.id);
  if (system.resolutionMode === 'progressive' || steps.length !== 1 || steps[0]?.timeRequirement
    || run?.steps?.some(step => step.timeGate || step.preparedConsumption) || Number(run?.currentStepIndex ?? 0) !== 0) {
    throw new Error('Stage 9a supports immediate single-step crafts only');
  }
}

// Use the stock matcher, including durable identity/source refs and legacy fallback.
// Ambiguous attribution cannot invent provenance: abort before roll/consumption.
function componentFor(engine, recipe, item, system, submissions) {
  if (submissions) {
    const ids = new Set(submissions.filter(row => row.item === item || row.item?.uuid === item?.uuid).map(row => row.componentId));
    if (ids.size !== 1) throw new Error('Alchemy item has no unambiguous submission identity');
    const id = [...ids][0];
    if (!system.components.some(component => component.id === id)) throw new Error('Unknown submitted component');
    return id;
  }
  const ids = system.components.filter(component => engine.recipeManager.ingredientMatchesItem(recipe,
    { match: { type: 'component', componentId: component.id } }, item)).map(component => component.id);
  if (ids.length > 1) throw new Error('Ambiguous consumed component');
  return ids[0] ?? null;
}

function composition(engine, recipe, system, selection, sources, options, submissions) {
  if (!Array.isArray(selection?.plan)) throw new Error('Unsupported native consumption plan');
  const rows = selection.plan.map(({ item, quantity }) => {
    if (!item?.uuid || !Number.isFinite(quantity) || quantity <= 0) throw new Error('Invalid consumption plan');
    return { itemUuid: item.uuid, actorUuid: item.parent?.uuid ?? null, quantity,
      componentId: componentFor(engine, recipe, item, system, submissions), kind: 'ingredient' };
  });
  if (options.isAlchemyAttempt) {
    if (!submissions || !Array.isArray(options.alchemySubmittedItems)) throw new Error('Missing bucketed alchemy submissions');
    // Exact stock _consumeAlchemyExtraItems rule: UUIDs touched by the plan are
    // excluded entirely, even if the submission contains more units of that stack.
    const consumed = new Set(rows.map(row => row.itemUuid)), counts = new Map();
    for (const item of options.alchemySubmittedItems) if (item.uuid && !consumed.has(item.uuid)) counts.set(item.uuid, (counts.get(item.uuid) ?? 0) + 1);
    for (const actor of sources) for (const item of actor.items ?? []) {
      const quantity = counts.get(item.uuid);
      if (quantity) rows.push({ itemUuid: item.uuid, actorUuid: actor.uuid ?? null, quantity,
        componentId: componentFor(engine, recipe, item, system, submissions), kind: 'extra' });
    }
  }
  return rows;
}

async function validateBehaviours(engine, candidates, sky, system, recipe, resolveUuid) {
  const definitions = system.essenceDefinitions ?? [];
  if (!Array.isArray(definitions)) throw new Error('Invalid essence definitions');
  const linked = [];
  for (const selected of candidates) {
    const essenceId = sky.properties[selected.propertyId].essenceId;
    const matches = definitions.filter(definition => definition.id === essenceId);
    if (!essenceId || matches.length !== 1 || matches[0].enabled === false) throw new Error('Property needs a current enabled essence');
    const definition = matches[0];
    let macro = false, effects = false;
    if (system.features?.essences === true && system.features?.propertyMacros === true && definition.propertyMacroUuid) {
      const doc = await resolveUuid(definition.propertyMacroUuid);
      if (!doc || doc.type !== 'script' || typeof doc.command !== 'string' || !doc.command.trim()) throw new Error('Essence macro is unavailable');
      macro = true;
    }
    if (system.features?.essences === true && system.features?.effectTransfer === true && recipe.transferEffects === true) {
      const uuid = engine._sourceUuidForEssenceDefinition(definition, system);
      if (uuid) {
        const doc = await resolveUuid(uuid);
        if (!doc) throw new Error('Essence effect source is unavailable');
        effects = Array.from(doc.effects ?? []).length > 0;
      }
    }
    if (!macro && !effects) throw new Error('Essence has no enabled behaviour for this recipe');
    linked.push({ propertyId: selected.propertyId, essenceId });
  }
  return linked;
}

export function installCraftAdapter({ engine, getGame, data, resolveUuid = uuid => globalThis.fromUuid(uuid), logger = console }) {
  if (!engine) throw new Error('Fabricate crafting engine is unavailable');
  if (installed.has(engine)) return installed.get(engine);
  const methods = ['craft', 'craftAlchemy', '_resolveCraftSelection', '_runCraftingCheck', '_sourceUuidForEssenceDefinition'];
  if (methods.some(key => typeof engine[key] !== 'function')) throw new Error('Unsupported Fabricate crafting contract');
  const nativeCraft = engine.craft, nativeAlchemy = engine.craftAlchemy;
  const reject = error => { if (getGame().user?.isGM) logger.warn('SkyBricate | Craft preflight rejected:', error.message); return failed(); };
  async function execute(receiver, args, submissions = null) {
    const [actor, sources, recipe, , options = {}] = args;
    let sky, rules, system;
    try {
      sky = data.getSnapshot().systems[recipe?.craftingSystemId];
      if (!configured(sky, recipe.id)) return nativeCraft.apply(receiver, args);
      const liveSystem = getGame().fabricate.getCraftingSystemManager().getSystem(recipe.craftingSystemId);
      system = liveSystem && copy(liveSystem.toJSON?.() ?? liveSystem);
      if (!system) throw new Error('Missing crafting system');
      supported(receiver, actor, recipe, system, options, getGame().fabricate.getCraftingRunManager?.());
      rules = copy(sky.recipeRules[recipe.id] ?? {});
      validateOutcomeLimits(rules, recipeOutcomes(system));
    } catch (error) { return reject(error); }
    const scope = Object.create(receiver);
    let rows = null, links = null;
    const nativeSelection = receiver._resolveCraftSelection, nativeCheck = receiver._runCraftingCheck;
    scope._resolveCraftSelection = function (...selectionArgs) {
      try {
        const selection = nativeSelection.apply(this, selectionArgs);
        rows = composition(this, recipe, system, selection, sources, options, submissions);
        return selection;
      } catch (error) {
        reject(error); rows = null;
        return { success: false, plan: [], currencySpends: [], missingGroups: [] };
      }
    };
    scope._runCraftingCheck = async function (...checkArgs) {
      try {
        if (!rows) throw new Error('Native plan was not captured');
        const componentIds = rows.map(row => row.componentId).filter(Boolean);
        const selections = rules.limitByCheck ? recipeOutcomes(system).flatMap(outcome => selectProperties({
          system: sky, componentIds, recipeRules: rules, outcome: outcome.id }))
          : selectProperties({ system: sky, componentIds, recipeRules: rules });
        const candidates = [...new Map(selections.map(property => [property.propertyId, property])).values()];
        links = await validateBehaviours(this, candidates, sky, system, recipe, resolveUuid);
      } catch (error) {
        reject(error);
        return { success: false, misconfigured: true, message: failed().message };
      }
      const check = await nativeCheck.apply(this, checkArgs);
      if (check.cancelled || check.misconfigured) return check;
      try {
        const mode = system.resolutionMode === 'alchemy' ? system.alchemy?.checkMode : system.resolutionMode;
        // Never use a routed display name as an ID. No-roll success has no outcome.
        const outcomeId = ['tiered', 'routedByCheck'].includes(mode) ? check.data?.outcomeId
          : ['pass', 'fail'].includes(check.outcome) ? check.outcome : null;
        if (rules.limitByCheck && !recipeOutcomes(system).some(row => row.id === outcomeId)) throw new Error('Unknown check outcome ID');
        const selected = selectProperties({ system: sky, componentIds: rows.map(row => row.componentId).filter(Boolean), recipeRules: rules, outcome: outcomeId });
        const strength = outcomeStrength(rules, recipeOutcomes(system), outcomeId);
        attempts.set(scope, { craftingSystemId: recipe.craftingSystemId, recipeId: recipe.id,
          actorUuid: actor.uuid, composition: copy(rows), checkResult: copy(check), outcomeId, strength,
          selected: selected.map(property => ({ ...property, essenceId: links.find(link => link.propertyId === property.propertyId).essenceId })) });
      } catch (error) {
        reject(error);
        return { success: false, misconfigured: true, message: failed().message };
      }
      return check;
    };
    const finalize = installResultApplication(scope, { system, sky, attempt: () => attempts.get(scope), resolveUuid });
    // Native failures after consumption propagate; there is no fabricated rollback.
    try { const result = await nativeCraft.apply(scope, args); await finalize(result); return result; }
    finally { attempts.delete(scope); }
  }
  const craft = function (...args) { return execute(this, args); };
  const alchemy = function (...args) {
    const scope = Object.create(this), submissions = args[2]?.map(row => ({ item: row.item, componentId: row.componentId }));
    scope.craft = (...craftArgs) => execute(scope, craftArgs, submissions);
    return nativeAlchemy.apply(scope, args);
  };
  engine.craft = craft; engine.craftAlchemy = alchemy;
  const dispose = () => {
    if (engine.craft === craft) engine.craft = nativeCraft;
    if (engine.craftAlchemy === alchemy) engine.craftAlchemy = nativeAlchemy;
    installed.delete(engine);
  };
  installed.set(engine, dispose);
  return dispose;
}
