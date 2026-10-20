// Execute unmodified, committed stock 1.9.10 modules. No Fabricate build/patch.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stockSources } from './fabricate-source.mjs';
import { installCraftAdapter, getCraftAttempt } from '../scripts/craft-adapter.js';
import { emptyData, emptySystem, emptyRecipeRules } from '../scripts/data-model.js';

const { upstream, read } = stockSources(process.argv[2]);
const cache = resolve('node_modules/.cache'); await mkdir(cache, { recursive: true });
const temp = await mkdtemp(resolve(cache, 'skybricate-craft-')), copied = new Set();
async function prepare(path) {
  if (copied.has(path)) return; copied.add(path);
  const source = read(path), out = resolve(temp, path); await mkdir(dirname(out), { recursive: true });
  for (const match of source.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g)) {
    if (match[1].startsWith('.')) await prepare(relative(upstream, resolve(upstream, dirname(path), match[1])).replaceAll('\\', '/'));
  }
  await writeFile(out, source);
}
const getProperty = (object, path) => String(path).split('.').reduce((value, key) => value?.[key], object);
const setProperty = (object, path, value) => {
  const keys = path.split('.'), last = keys.pop(); let target = object;
  for (const key of keys) target = target[key] ??= {};
  target[last] = value; return true;
};
let sequence = 0, rollTotal = 17, rolls = 0;
globalThis.foundry = { utils: { randomID: () => `id${++sequence}`, getProperty, setProperty, deepClone: structuredClone } };
globalThis.ui = { notifications: { info() {}, warn() {}, error() {} } };
globalThis.game = {};
globalThis.Roll = class {
  constructor(formula) { this.formula = formula; }
  async evaluate() { rolls++; return { total: rollTotal, dice: [], terms: [], formula: this.formula }; }
};

try {
  for (const path of ['src/systems/CraftingEngine.js', 'src/systems/RecipeManager.js', 'src/systems/ResolutionModeService.js', 'src/models/Recipe.js', 'src/utils/alchemySubmissions.js']) await prepare(path);
  const stock = path => import(pathToFileURL(resolve(temp, path)));
  const { CraftingEngine } = await stock('src/systems/CraftingEngine.js');
  const { RecipeManager } = await stock('src/systems/RecipeManager.js');
  const { Recipe } = await stock('src/models/Recipe.js');
  const { ResolutionModeService } = await stock('src/systems/ResolutionModeService.js');
  const { resolveAlchemySubmissions } = await stock('src/utils/alchemySubmissions.js');

  function fixture({ mode = 'simple', checkMode = 'simple', quantities = [3, 1], groups = ['a', 'b'], configured = true } = {}) {
    const counters = { updates: 0, deletes: 0, creates: 0, macroCalls: 0, selections: 0, consumes: 0 }, captures = [], warnings = [];
    const actor = { id: 'actor', uuid: 'Actor.actor', name: 'Actor', items: [], getRollData: () => ({}) };
    const item = (id, quantity) => ({ id, uuid: `Actor.actor.Item.${id}`, parent: actor, name: id.toUpperCase(), system: { quantity },
      _stats: { duplicateSource: `Item.${id}` }, flags: {},
      async delete() { counters.deletes++; actor.items = actor.items.filter(row => row !== this); this.deleted = true; },
      async update(patch) { counters.updates++; for (const [path, value] of Object.entries(patch)) setProperty(this, path, value); } });
    actor.items = quantities.map((quantity, index) => item(['a', 'b', 'c'][index], quantity));
    const initialItems = [...actor.items];
    actor.createEmbeddedDocuments = async (type, data) => { counters.creates += data.length; return data.map((value, i) => ({ ...value, id: `created${i}`, uuid: `Actor.actor.Item.created${i}`, parent: actor })); };
    const system = { id: 's', name: 'System', resolutionMode: mode, features: { essences: true, effectTransfer: true, propertyMacros: true, chatOutput: false },
      requirements: { time: { enabled: false } },
      craftingCheck: { enabled: true, simple: { rollFormula: '1d20', dc: 10, dcMode: 'static' },
        routed: { rollFormula: '1d20', type: 'relative', dc: 10, relativeOutcomes: [{ id: 'good', name: 'Display success', dc: 0, success: true }, { id: 'bad', name: 'Display failure', dc: -100, success: false }] } },
      alchemy: { checkMode, consumeOnFail: true, learnOnCraft: false, showAttemptHistoryToPlayers: false },
      components: ['a', 'b', 'c', 'result'].map(id => ({ id, name: id.toUpperCase(), registeredItemUuid: `Item.${id}` })),
      essenceDefinitions: [{ id: 'e', name: 'Essence', propertyMacroUuid: 'Macro.e', sourceComponentId: 'a' }] };
    const recipe = new Recipe({ id: 'recipe', name: 'Recipe', enabled: true, craftingSystemId: 's', transferEffects: true,
      ingredientSets: [{ id: 'set', ingredientGroups: groups.map((id, index) => ({ id: `group${index}`, options: [{ match: { type: 'component', componentId: id }, quantity: 1 }] })) }],
      resultGroups: [{ id: 'success', name: mode === 'routedByCheck' || checkMode === 'tiered' ? 'Display success' : 'Success', results: [{ id: 'res', componentId: 'result', quantity: 1 }] },
        { id: 'failure', name: mode === 'routedByCheck' || checkMode === 'tiered' ? 'Display failure' : 'Failure', role: 'failure', results: [{ id: 'failres', componentId: 'result', quantity: 1 }] }],
      outcomeRouting: { good: 'success', bad: 'failure' } });
    const systemManager = { getSystem: id => id === 's' ? system : null };
    const resolution = new ResolutionModeService(systemManager);
    const manager = new RecipeManager({ getCraftingSystem: () => system, getCraftingSystemManager: () => systemManager }); manager.recipes.set(recipe.id, recipe);
    const engine = new CraftingEngine(manager, null, resolution);
    const sky = emptyData();
    if (configured) { sky.systems.s = emptySystem(); Object.assign(sky.systems.s, { properties: { p: { name: 'Secret property', description: '', essenceId: 'e' } }, components: { a: ['p'], b: ['p'], c: ['p'] } }); }
    globalThis.game = { user: { id: 'gm', isGM: true }, actors: [actor], time: { worldTime: 0 },
      i18n: { localize: key => key, format: key => key }, settings: { get: () => null },
      fabricate: { getCraftingSystemManager: () => systemManager, getRecipeManager: () => manager,
        getCraftingRunManager: () => null, getResolutionModeService: () => resolution } };
    const game = globalThis.game;
    globalThis.fromUuid = async uuid => uuid === 'Macro.e' ? { type: 'script', command: 'return {"system.power": 1};' }
      : { name: uuid, effects: [{ toObject: () => ({ name: 'Effect', changes: [{ key: 'system.power', value: 1 }] }) }],
        toObject: () => ({ name: uuid, type: 'loot', system: { quantity: 1 }, flags: {} }) };
    const nativeCreate = engine._createResultItems, nativeSelect = engine._resolveCraftSelection, nativeConsume = engine._consumeIngredients;
    engine._createResultItems = async function (...args) { captures.push(getCraftAttempt(this)); return nativeCreate.apply(this, args); };
    engine._resolveCraftSelection = function (...args) { counters.selections++; return nativeSelect.apply(this, args); };
    engine._consumeIngredients = function (...args) { counters.consumes++; return nativeConsume.apply(this, args); };
    installCraftAdapter({ engine, getGame: () => game, data: { getSnapshot: () => structuredClone(sky) }, logger: { warn: (...args) => warnings.push(args) } });
    const craft = options => engine.craft(actor, [actor], recipe, null, options);
    const brew = ids => engine.craftAlchemy(actor, [actor], resolveAlchemySubmissions([actor], system.components, ids, 's'), { craftingSystemId: 's' });
    return { engine, manager, resolution, system, recipe, sky, actor, initialItems, counters, captures, warnings, craft, brew };
  }

  let f = fixture(); rolls = 0;
  assert.equal((await f.craft()).success, true); assert.equal(rolls, 1); assert.equal(f.counters.selections, 1); assert.equal(f.counters.consumes, 1);
  assert.equal(f.counters.updates, 1); assert.equal(f.counters.deletes, 1); assert.equal(f.counters.creates, 1);
  assert.deepEqual(f.captures[0].composition.map(row => [row.componentId, row.quantity]), [['a', 1], ['b', 1]]);
  assert.equal(f.captures[0].selected[0].propertyId, 'p'); assert.equal(f.captures[0].selected[0].sources.length, 2);
  assert.equal(getCraftAttempt(f.engine), null);
  // Candidate metadata never leaks into stock result/run/chat payloads.
  assert(!JSON.stringify(f.actor, (key, value) => key === 'parent' ? undefined : value).includes('Secret property'));

  f = fixture({ groups: ['a', 'a'], quantities: [2] }); rolls = 0;
  assert.equal((await f.craft()).success, true); assert.deepEqual(f.captures[0].selected, []);
  assert.equal(f.counters.deletes, 1); assert.equal(rolls, 1);

  f = fixture({ mode: 'alchemy', quantities: [3, 1, 2] }); rolls = 0;
  assert.equal((await f.brew(['a', 'b', 'c', 'c', 'a'])).success, true);
  assert.equal(f.counters.selections, 1); assert.equal(rolls, 1);
  assert.deepEqual(f.captures[0].composition.map(row => [row.componentId, row.quantity, row.kind]), [['a', 1, 'ingredient'], ['b', 1, 'ingredient'], ['c', 2, 'extra']]);
  assert.equal(f.initialItems[0].system.quantity, 2, 'stock UUID exclusion means surplus units of a planned stack are not extras');
  assert.equal(f.initialItems[2].deleted, true);

  for (const configured of [true, false]) {
    f = fixture({ mode: 'alchemy', configured }); rolls = 0;
    const noMatch = await f.brew(['a']); assert.equal(noMatch.disposition, 'no-match'); assert.equal(rolls, 0); assert.equal(f.captures.length, 0);
  }

  f = fixture({ mode: 'alchemy' }); rollTotal = 1; rolls = 0;
  const fail = await f.brew(['a', 'b']); assert.equal(fail.success, false); assert.equal(fail.disposition, 'produced-on-failure');
  assert.equal(rolls, 1); assert.equal(f.captures[0].checkResult.success, false); assert.equal(f.captures[0].outcomeId, 'fail');
  rollTotal = 17;

  for (const [mode, checkMode] of [['routedByCheck', 'simple'], ['alchemy', 'tiered']]) {
    f = fixture({ mode, checkMode }); rolls = 0;
    f.sky.systems.s.recipeRules.recipe = { ...emptyRecipeRules(), allowedPropertyIds: ['p'], limitByCheck: true, outcomeLimits: { good: 1, bad: 0 } };
    const result = mode === 'alchemy' ? await f.brew(['a', 'b']) : await f.craft();
    assert.equal(result.success, true, JSON.stringify({ message: result.message, warnings: f.warnings })); assert.equal(rolls, 1);
    assert.equal(f.captures[0].outcomeId, 'good'); assert.equal(f.captures[0].checkResult.outcome, 'Display success');
  }

  f = fixture({ mode: 'alchemy', checkMode: 'none' }); rolls = 0;
  assert.equal((await f.brew(['a', 'b'])).success, true); assert.equal(rolls, 0); assert.equal(f.captures[0].outcomeId, null);
  f = fixture({ mode: 'alchemy', checkMode: 'none' }); rolls = 0;
  f.sky.systems.s.recipeRules.recipe = { ...emptyRecipeRules(), allowedPropertyIds: ['p'], limitByCheck: true, outcomeLimits: { pass: 1 } };
  assert.equal((await f.brew(['a', 'b'])).success, false); assert.equal(f.counters.updates + f.counters.deletes + rolls, 0);

  f = fixture(); rolls = 0;
  delete f.sky.systems.s.properties.p.essenceId;
  assert.equal((await f.craft()).success, false); assert.equal(f.counters.updates + f.counters.deletes + rolls, 0);

  f = fixture(); rolls = 0;
  // Exercise stock interactive cancellation without replacing _runCraftingCheck.
  globalThis.foundry.applications = { api: { DialogV2: { wait: async () => null } } };
  const cancelled = await f.craft({ interactive: true });
  assert.equal(cancelled.cancelled, true); assert.equal(rolls, 0); assert.equal(f.counters.consumes, 0);
  delete globalThis.foundry.applications;

  // Prove the future 9b contract with STOCK behaviours, separately from the 9a
  // runtime adapter: one precomputed selected map drives BOTH paths; a local
  // definitions list controls macro order. Native configuration stays unchanged.
  f = fixture(); const selected = { e: 2 }, enabled = { e: true, unrelated: false }, macroCalls = [], effects = [];
  f.system.essenceDefinitions.push({ id: 'unrelated', name: 'Unselected', propertyMacroUuid: 'Macro.unrelated', sourceComponentId: 'b' });
  const before = structuredClone(f.system), receiver = Object.create(f.engine);
  globalThis.__stockMacroProbe = macroCalls;
  const sourceResolver = globalThis.fromUuid;
  globalThis.fromUuid = async uuid => uuid.startsWith('Macro.') ? { type: 'script',
    command: 'globalThis.__stockMacroProbe.push([context.essence.id, context.essenceQuantity]); return {"system.power": context.essenceQuantity};' } : sourceResolver(uuid);
  const itemData = { system: {} };
  assert.equal(await receiver._runEssencePropertyMacros(itemData, { system: { ...f.system, essenceDefinitions: [f.system.essenceDefinitions[0]] },
    recipe: f.recipe, craftingActor: f.actor, result: {}, consumedItems: [], toolItems: [], precomputedEssences: selected, essenceEnabled: enabled }), true);
  await receiver._transferEffects({ createEmbeddedDocuments: async (type, rows) => effects.push(...rows) }, [], f.recipe, selected, undefined, enabled);
  assert.deepEqual(macroCalls, [['e', 2]]); assert.equal(itemData.system.power, 2); assert.equal(effects.length, 1); assert.deepEqual(f.system, before);
  delete globalThis.__stockMacroProbe;
  console.log('PASS stock 1.9.10: actual engine/recipe manager/ingredient plan/checks/results, one roll/selection/consumption, duplicate component IDs, partial/full stacks, bucketed alchemy/extras/UUID exclusion, success/failure/cancel/no-match, none/simple/tiered outcome IDs and preflight; future shared selected-map macro/effect seams.');
} finally { await rm(temp, { recursive: true, force: true }); }
