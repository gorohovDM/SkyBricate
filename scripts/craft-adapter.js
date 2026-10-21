import { copy, assertKey } from './data-model.js';
import { selectProperties } from './property-selection.js';
import { recipeOutcomes, validateOutcomeLimits, outcomeStrength } from './recipe-contract.js';
import { installResultApplication } from './craft-application.js';
import { persistedSystems } from './assignment-contract.js';
import { fingerprint, runRevision, runBinding, validateRun } from './craft-run-context.js';

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
const configurationError = (code, message) => Object.assign(new Error(message), { skybricateCode: code });
function failed(game, error) {
  const key = `SKYBRICATE.Craft.${game.user?.isGM ? error?.skybricateCode ?? 'Configuration' : 'AskGM'}`;
  const localized = game.i18n?.localize(key);
  const fallback = game.user?.isGM ? `SkyBricate: ${error?.message ?? 'Check crafting configuration.'}`
    : 'SkyBricate: crafting configuration is unavailable or unsupported; ask the GM.';
  return { success: false, results: null, disposition: 'skybricate-configuration', message: localized && localized !== key ? localized : fallback };
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
    if (!essenceId || matches.length !== 1 || matches[0].enabled === false) throw configurationError('EssenceRequired', 'Property needs a current enabled essence');
    const definition = matches[0];
    let macro = false, effects = false;
    if (system.features?.essences === true && system.features?.propertyMacros === true && definition.propertyMacroUuid) {
      const doc = await Promise.resolve().then(() => resolveUuid(definition.propertyMacroUuid)).catch(() => null);
      if (!doc || doc.type !== 'script' || typeof doc.command !== 'string' || !doc.command.trim()) throw configurationError('MacroUnavailable', 'Essence macro is unavailable');
      macro = true;
    }
    if (system.features?.essences === true && system.features?.effectTransfer === true && recipe.transferEffects === true) {
      const uuid = engine._sourceUuidForEssenceDefinition(definition, system);
      if (uuid) {
        const doc = await Promise.resolve().then(() => resolveUuid(uuid)).catch(() => null);
        if (!doc) throw configurationError('EffectUnavailable', 'Essence effect source is unavailable');
        effects = Array.from(doc.effects ?? []).length > 0;
      }
    }
    if (!macro && !effects) throw configurationError('BehaviourRequired', 'Essence has no enabled behaviour for this recipe');
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
  const reject = error => { if (getGame().user?.isGM) logger.warn('SkyBricate | Craft preflight rejected:', error.message); return failed(getGame(), error); };
  async function execute(receiver, args, submissions = null) {
    const [actor, sources, recipe, , options = {}] = args;
    const runManager = engine.craftingRunManager || getGame().fabricate.getCraftingRunManager?.();
    let run = options.runId ? runManager?.getActiveRun?.(actor, options.runId) : runManager?.findActiveRunForRecipe?.(actor, recipe.id);
    let sky, rules, system, revision, prepared;
    try {
      sky = data.getSnapshot().systems[recipe?.craftingSystemId];
      if (!configured(sky, recipe.id) && !run?.skybricate) return nativeCraft.apply(receiver, args);
      if (!sky) throw new Error('Missing SkyBricate configuration');
      const liveSystem = getGame().fabricate.getCraftingSystemManager().getSystem(recipe.craftingSystemId);
      system = liveSystem && copy(liveSystem.toJSON?.() ?? liveSystem);
      if (!system) throw new Error('Missing crafting system');
      rules = copy(sky.recipeRules[recipe.id] ?? {});
      validateOutcomeLimits(rules, recipeOutcomes(system));
      revision = runRevision(system, sky, recipe);
      if (run) prepared = validateRun(run, runBinding(actor, recipe, revision, run), system);
      const steps = recipe.getExecutionSteps?.() ?? [{}];
      if (!runManager && (steps.length > 1 || steps.some(step => step.timeRequirement))) throw new Error('Crafting run manager is required');
    } catch (error) { return reject(error); }
    const scope = Object.create(engine);
    // Collapsed chains recurse through craft. Start a fresh receiver for each
    // step rather than nesting the previous step's selection/check wrappers.
    scope.craft = (...nextArgs) => execute(engine, nextArgs);
    let rows = prepared?.composition ?? null, links = null;
    const nativeSelection = engine._resolveCraftSelection, nativeCheck = engine._runCraftingCheck;
    const preflight = async () => {
      if (!rows) throw new Error('Native plan was not captured');
      const componentIds = rows.map(row => row.componentId).filter(Boolean);
      const selections = rules.limitByCheck ? recipeOutcomes(system).flatMap(outcome => selectProperties({
        system: sky, componentIds, recipeRules: rules, outcome: outcome.id }))
        : selectProperties({ system: sky, componentIds, recipeRules: rules });
      const candidates = [...new Map(selections.map(property => [property.propertyId, property])).values()];
      const behaviours = copy(system);
      if (prepared) for (const definition of behaviours.essenceDefinitions ?? []) definition.enabled = prepared.essenceEnabled[definition.id];
      links = await validateBehaviours(scope, candidates, sky, behaviours, recipe, resolveUuid);
    };
    if (runManager) {
      const manager = Object.create(runManager);
      scope.craftingRunManager = manager;
      for (const key of ['getActiveRun', 'findActiveRunForRecipe']) manager[key] = function (...lookupArgs) {
        const current = runManager[key](...lookupArgs);
        if (current) run = current;
        return current;
      };
      manager.createRun = async function (...createArgs) {
        run = await runManager.createRun(...createArgs);
        run.skybricate = runBinding(actor, recipe, revision, run);
        await runManager.updateRun(actor, run);
        return run;
      };
      manager.markStepPrepared = async function (owner, current, index, snapshot) {
        const state = current.steps[index].skybricate;
        if (!state) throw new Error('Missing pre-consumption provenance');
        state.prepared = fingerprint(snapshot);
        return runManager.markStepPrepared(owner, current, index, snapshot);
      };
      const nativeConsume = engine._consumeIngredients;
      scope._consumeIngredients = async function (...consumeArgs) {
        // Timed START has no roll seam. Validate every possible selection and
        // durably save identities BEFORE native deletion of source documents.
        if (!attempts.has(scope)) {
          // Unlike the immediate alchemy path, stock timed START consumes only
          // the selection plan; submitted alchemy extras are not consumed here.
          if (rows) rows = rows.filter(row => row.kind === 'ingredient');
          try { await preflight(); }
          catch (error) { error.skybricatePreflight = true; throw error; }
        }
        if (run) {
          const index = run.currentStepIndex, step = run.steps[index];
          const essenceEnabled = Object.fromEntries((system.essenceDefinitions ?? []).map(row => [row.id, row.enabled !== false]));
          step.skybricate = { index, stepId: step.stepId, composition: copy(rows), essenceEnabled,
            digest: fingerprint([rows, essenceEnabled]) };
          await runManager.updateRun(actor, run);
        }
        return nativeConsume.apply(this, consumeArgs);
      };
    }
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
        await preflight();
      } catch (error) {
        return { ...reject(error), misconfigured: true };
      }
      const check = await nativeCheck.apply(this, checkArgs);
      if (check.cancelled || check.misconfigured) return check;
      try {
        const mode = system.resolutionMode === 'alchemy' ? system.alchemy?.checkMode : system.resolutionMode;
        // Never use a routed display name as an ID. No-roll success has no outcome.
        const outcomeId = !recipeOutcomes(system).length ? null : ['tiered', 'routedByCheck'].includes(mode) ? check.data?.outcomeId
          : ['pass', 'fail'].includes(check.outcome) ? check.outcome : null;
        if (rules.limitByCheck && !recipeOutcomes(system).some(row => row.id === outcomeId)) throw new Error('Unknown check outcome ID');
        const selected = selectProperties({ system: sky, componentIds: rows.map(row => row.componentId).filter(Boolean), recipeRules: rules, outcome: outcomeId });
        const strength = outcomeStrength(rules, recipeOutcomes(system), outcomeId);
        attempts.set(scope, { craftingSystemId: recipe.craftingSystemId, recipeId: recipe.id,
          actorUuid: actor.uuid, composition: copy(rows), checkResult: copy(check), outcomeId, strength,
          ...(prepared ? { essenceEnabled: copy(prepared.essenceEnabled) } : {}),
          selected: selected.map(property => ({ ...property, essenceId: links.find(link => link.propertyId === property.propertyId).essenceId })) });
      } catch (error) {
        return { ...reject(error), misconfigured: true };
      }
      return check;
    };
    const finalize = installResultApplication(scope, { system, sky, attempt: () => attempts.get(scope), resolveUuid });
    if (typeof engine._postCraftChatMessage === 'function') {
      scope._postCraftChatMessage = async function (...chatArgs) {
        const posted = await engine._postCraftChatMessage.apply(this, chatArgs);
        // A collapsed chain returns only its last award. Earlier actual awards
        // are confirmed by the completed step's native chat seam before recursion.
        await finalize({ success: chatArgs[0].success, results: chatArgs[0].createdResults });
        return posted;
      };
    }
    // Native failures after consumption propagate; there is no fabricated rollback.
    try { const result = await nativeCraft.apply(scope, args); await finalize(result); return result; }
    catch (error) { if (error.skybricatePreflight) return reject(error); throw error; }
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
