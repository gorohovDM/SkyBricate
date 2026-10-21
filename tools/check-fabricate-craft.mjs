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
  for (const key of keys) { if (target[key] === undefined) target[key] = {}; target = target[key]; }
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
  for (const path of ['src/systems/CraftingEngine.js', 'src/systems/CraftingRunManager.js', 'src/systems/RecipeManager.js', 'src/systems/ResolutionModeService.js', 'src/models/Recipe.js', 'src/utils/alchemySubmissions.js']) await prepare(path);
  const stock = path => import(pathToFileURL(resolve(temp, path)));
  const { CraftingEngine } = await stock('src/systems/CraftingEngine.js');
  const { CraftingRunManager } = await stock('src/systems/CraftingRunManager.js');
  const { RecipeManager } = await stock('src/systems/RecipeManager.js');
  const { Recipe } = await stock('src/models/Recipe.js');
  const { ResolutionModeService } = await stock('src/systems/ResolutionModeService.js');
  const { resolveAlchemySubmissions } = await stock('src/utils/alchemySubmissions.js');

  function fixture({ mode = 'simple', checkMode = 'simple', quantities = [3, 1], groups = ['a', 'b'], configured = true, runs = false } = {}) {
    const counters = { updates: 0, deletes: 0, creates: 0, auditUpdates: 0, effectCalls: 0, effects: 0, macroCalls: 0, selections: 0, consumes: 0 }, captures = [], warnings = [];
    const runtime = { macros: { 'Macro.e': 'return {"system.power": context.essenceQuantity};' },
      effects: [{ name: 'Effect', changes: [{ key: 'system.power', value: 1 }] }], sourceSystem: { quantity: 1 } };
    const actor = { id: 'actor', uuid: 'Actor.actor', name: 'Actor', items: [], getRollData: () => ({}) };
    const flags = {};
    actor.getFlag = (scope, key) => structuredClone(flags[`${scope}.${key}`]);
    actor.setFlag = async (scope, key, value) => { flags[`${scope}.${key}`] = JSON.parse(JSON.stringify(value)); };
    const item = (id, quantity) => ({ id, uuid: `Actor.actor.Item.${id}`, parent: actor, name: id.toUpperCase(), system: { quantity },
      _stats: { duplicateSource: `Item.${id}` }, flags: {},
      async delete() { counters.deletes++; actor.items = actor.items.filter(row => row !== this); this.deleted = true; },
      async update(patch) { counters.updates++; for (const [path, value] of Object.entries(patch)) setProperty(this, path, value); } });
    actor.items = quantities.map((quantity, index) => item(['a', 'b', 'c'][index], quantity));
    const initialItems = [...actor.items];
    actor.createEmbeddedDocuments = async (type, data) => {
      counters.creates += data.length;
      if (runtime.createThrows) throw new Error('Creation failed');
      if (runtime.createEmpty) return [];
      const documents = data.map(value => {
        const id = `created${++sequence}`, document = { ...structuredClone(value), id, uuid: `Actor.actor.Item.${id}`, parent: actor,
          effects: (value.effects ?? []).map(effect => ({ ...structuredClone(effect), id: `base${++sequence}` })) };
        if (runtime.normalize) runtime.normalize(document);
        document.toObject = () => Object.fromEntries(Object.entries(document).filter(([key, row]) => key !== 'parent' && typeof row !== 'function'));
        document.update = async patch => { counters.auditUpdates++; for (const [path, row] of Object.entries(patch)) setProperty(document, path, row); return document; };
        document.createEmbeddedDocuments = async (type, rows) => {
          counters.effectCalls++;
          if (runtime.effectThrows) throw new Error('Effect creation failed');
          counters.effects += rows.length;
          if (runtime.effectEmpty) return [];
          const effects = rows.map(row => ({ ...structuredClone(row), id: `effect${++sequence}` })); document.effects.push(...effects); return effects;
        };
        return document;
      });
      actor.items.push(...documents); return documents;
    };
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
    const engine = new CraftingEngine(manager, runs ? new CraftingRunManager() : null, resolution);
    const sky = emptyData();
    if (configured) { sky.systems.s = emptySystem(); Object.assign(sky.systems.s, { properties: { p: { name: 'Secret property', description: '', essenceId: 'e' } }, components: { a: ['p'], b: ['p'], c: ['p'] } }); }
    globalThis.game = { user: { id: 'gm', isGM: true }, actors: [actor], time: { worldTime: 0 },
      i18n: { localize: key => key, format: key => key }, settings: { get: () => null },
      fabricate: { getCraftingSystemManager: () => systemManager, getRecipeManager: () => manager,
        getCraftingRunManager: () => engine.craftingRunManager, getResolutionModeService: () => resolution } };
    const game = globalThis.game;
    globalThis.fromUuid = async uuid => uuid.startsWith('Macro.') ? (runtime.macros[uuid] === undefined ? null : { type: 'script', command: runtime.macros[uuid] })
      : { name: uuid, effects: (runtime.effectsByUuid?.[uuid] ?? runtime.effects).map(row => ({ toObject: () => structuredClone(row) })),
        toObject: () => ({ name: uuid, type: 'loot', system: structuredClone(runtime.sourceSystem), flags: structuredClone(runtime.sourceFlags ?? {}), effects: structuredClone(runtime.baseEffects ?? []) }) };
    const nativeCreate = engine._createResultItems, nativeSelect = engine._resolveCraftSelection, nativeConsume = engine._consumeIngredients;
    engine._createResultItems = async function (...args) { captures.push(getCraftAttempt(this)); return nativeCreate.apply(this, args); };
    engine._resolveCraftSelection = function (...args) { counters.selections++; return nativeSelect.apply(this, args); };
    engine._consumeIngredients = function (...args) { counters.consumes++; return nativeConsume.apply(this, args); };
    installCraftAdapter({ engine, getGame: () => game, data: { getSnapshot: () => structuredClone(sky) }, logger: { warn: (...args) => warnings.push(args) } });
    const craft = options => engine.craft(actor, [actor], recipe, null, options);
    const brew = ids => engine.craftAlchemy(actor, [actor], resolveAlchemySubmissions([actor], system.components, ids, 's'), { craftingSystemId: 's' });
    const reload = () => { engine.craftingRunManager = new CraftingRunManager(); };
    return { engine, manager, resolution, system, recipe, sky, actor, initialItems, counters, captures, warnings, runtime, craft, brew, reload, flags, game };
  }

  let f = fixture(); rolls = 0;
  let crafted = await f.craft();
  assert.equal(crafted.success, true); assert.equal(rolls, 1); assert.equal(f.counters.selections, 1); assert.equal(f.counters.consumes, 1);
  assert.equal(crafted.results[0].system.power, 1);
  assert.equal(crafted.results[0].flags.skybricate.application.applied[0].propertyId, 'p');
  assert.equal(crafted.results[0].flags.skybricate.application.applied[0].macro, true);
  assert.equal(crafted.results[0].flags.skybricate.application.applied[0].effects, true);
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

  const audit = result => result.results[0]?.flags?.skybricate?.application;
  const configure = (f, extra = {}) => { f.sky.systems.s.recipeRules.recipe = {
    ...emptyRecipeRules(), allowedPropertyIds: ['p'], ...extra }; };
  const quiet = async action => {
    const previous = console.error; console.error = () => {};
    try { return await action(); } finally { console.error = previous; }
  };
  // Strength is a distinct outcome setting, never an ingredient amount or limit.
  for (const [total, strength, success] of [[17, 2.5, true], [1, 0.5, false]]) {
    f = fixture(); f.recipe.transferEffects = false; rollTotal = total; rolls = 0;
    configure(f, { limitByCheck: true, outcomeLimits: { pass: 1, fail: 1 }, outcomeStrengths: { pass: 2.5, fail: 0.5 } });
    crafted = await f.craft(); assert.equal(crafted.success, success); assert.equal(rolls, 1);
    assert.equal(crafted.results[0].system.power, strength); assert.equal(audit(crafted).strength, strength);
    assert.equal(audit(crafted).checkSuccess, success); assert.equal(audit(crafted).applied.length, 1);
    assert.equal(audit(crafted).craftSuccess, success);
    assert.deepEqual(audit(crafted).applied[0].sources.map(row => row.items[0].quantity), [1, 1]);
  }
  rollTotal = 17;
  f = fixture({ mode: 'routedByCheck' }); configure(f, { outcomeStrengths: { good: 4, bad: 0.25 } });
  crafted = await f.craft(); assert.equal(crafted.results[0].system.power, 4); assert.equal(audit(crafted).outcomeId, 'good');
  f = fixture({ mode: 'alchemy', checkMode: 'none', quantities: [20, 20] }); configure(f, { outcomeStrengths: {} }); rolls = 0;
  crafted = await f.brew(['a', 'b']); assert.equal(rolls, 0); assert.equal(crafted.results[0].system.power, 1);

  f = fixture(); configure(f, { outcomeStrengths: { pass: 2 } }); rolls = 0;
  assert.equal((await f.craft()).success, false); assert.equal(rolls + f.counters.consumes, 0);
  f = fixture(); f.engine._runCraftingCheck = async () => { rolls++; return { success: true, outcome: 'unknown' }; }; rolls = 0;
  assert.equal((await f.craft()).success, false); assert.equal(rolls, 1); assert.equal(f.counters.consumes, 0);

  // Keep independent native essences (and their source metadata/quantities), but
  // exclude every catalog-linked essence unless selected, even when on ingredients.
  f = fixture(); configure(f, { outcomeStrengths: { pass: 3, fail: 1 } });
  f.sky.systems.s.properties.cut = { name: 'Hidden cut', description: '', essenceId: 'cut' };
  for (const ids of Object.values(f.sky.systems.s.components)) ids.push('cut');
  f.system.essenceDefinitions.push({ id: 'cut', name: 'Hidden cut', propertyMacroUuid: 'Macro.cut', sourceComponentId: 'a' },
    { id: 'native', name: 'Independent', propertyMacroUuid: 'Macro.native', sourceComponentId: 'a' });
  f.system.components.find(row => row.id === 'a').essences = { e: 70, cut: 80, native: 2 };
  f.system.components.find(row => row.id === 'b').essences = { e: 7, cut: 8, native: 3 };
  globalThis.__stockMacroProbe = [];
  f.runtime.macros['Macro.native'] = 'globalThis.__stockMacroProbe.push(["native",context.essenceQuantity,context.essenceSources.native.length]); return {"system.native":context.essenceQuantity};';
  f.runtime.macros['Macro.cut'] = 'throw new Error("cut must not execute")';
  f.runtime.macros['Macro.e'] = 'globalThis.__stockMacroProbe.push(["sky",context.essenceQuantity]); return {"system.power":context.essenceQuantity};';
  f.recipe.resultGroups[0].results[0].propertyMacroUuid = 'Macro.result';
  f.runtime.macros['Macro.result'] = 'globalThis.__stockMacroProbe.push(["result",context.resolvedEssences.e,context.resolvedEssences.native]); return {"system.result":9};';
  crafted = await f.craft(); assert.deepEqual(globalThis.__stockMacroProbe, [['native', 5, 2], ['sky', 3], ['result', 3, 5]]);
  assert.equal(crafted.results[0].system.native, 5); assert.equal(crafted.results[0].effects.length, 2);
  assert.deepEqual(audit(crafted).applied.map(row => row.propertyId), ['p']);
  assert(!JSON.stringify(audit(crafted)).includes('cut'));

  // Numeric essence IDs must not reorder either path; effect transfer remains one native batch.
  f = fixture(); configure(f, { allowedPropertyIds: ['p', 'second'], propertyOrder: ['second', 'p'] });
  f.sky.systems.s.properties.second = { name: 'Second secret', description: '', essenceId: '2' };
  f.sky.systems.s.properties.p.essenceId = '1';
  for (const ids of Object.values(f.sky.systems.s.components)) ids.push('second');
  f.system.essenceDefinitions = [{ id: '1', propertyMacroUuid: 'Macro.e', sourceItemUuid: 'Item.one' }, { id: '2', propertyMacroUuid: 'Macro.two', sourceItemUuid: 'Item.two' }];
  f.runtime.macros['Macro.e'] = 'globalThis.__stockMacroProbe.push("1"); return {"system.power":1}';
  f.runtime.macros['Macro.two'] = 'globalThis.__stockMacroProbe.push("2"); return {"system.power":2}';
  f.runtime.effectsByUuid = { 'Item.one': [{ name: 'One', changes: [{ key: 'system.one', value: 1 }] }], 'Item.two': [{ name: 'Two', changes: [{ key: 'system.two', value: 2 }] }] };
  globalThis.__stockMacroProbe = []; const definitionSnapshot = structuredClone(f.system.essenceDefinitions);
  crafted = await f.craft(); assert.deepEqual(globalThis.__stockMacroProbe, ['2', '1']);
  assert.deepEqual(crafted.results[0].effects.map(row => row.name), ['Two', 'One']);
  assert.equal(f.counters.effectCalls, 1);
  assert.deepEqual(f.system.essenceDefinitions, definitionSnapshot); assert.equal(crafted.results[0].system.power, 1);
  assert.deepEqual(audit(crafted).applied.map(row => [row.propertyId, row.macro, row.effects]), [['second', false, true], ['p', true, true]]);

  // No-op, empty, thrown, overwritten, normalized-away and partial macro writes.
  for (const command of ['return {};', 'return null;', 'throw new Error("expected macro failure")', 'return {"system.power":1}']) {
    f = fixture(); f.recipe.transferEffects = false; f.runtime.sourceSystem.power = 1; f.runtime.macros['Macro.e'] = command;
    crafted = await quiet(() => f.craft()); assert.deepEqual(audit(crafted).applied, []);
  }
  for (const updates of ['{"system.power":1}', '{"system":{"quantity":1,"power":1}}']) {
    f = fixture(); f.recipe.transferEffects = false;
    f.recipe.resultGroups[0].results[0].propertyMacroUuid = 'Macro.result';
    f.runtime.macros['Macro.result'] = `return ${updates};`;
    crafted = await f.craft(); assert.deepEqual(audit(crafted).applied, [], 'later writes own an overlapping path, even an identical value');
  }
  f = fixture(); f.recipe.transferEffects = false; f.runtime.normalize = document => { delete document.system.power; document.system.normalized = 1; };
  crafted = await f.craft(); assert.deepEqual(audit(crafted).applied, []);
  f = fixture(); f.recipe.transferEffects = false; f.runtime.sourceSystem.container = null;
  f.runtime.macros['Macro.e'] = 'return {"system.survives":7,"system.container.bad":2,"system.unreached":3}';
  crafted = await quiet(() => f.craft()); assert.equal(crafted.results[0].system.survives, 7);
  assert.equal(crafted.results[0].system.unreached, undefined); assert.equal(audit(crafted).applied[0].macro, true);

  // Effect-only outputs stay individual, but uncreated, disabled or duplicate
  // effects do not prove application. The independent duplicate is retained.
  f = fixture(); delete f.system.essenceDefinitions[0].propertyMacroUuid; f.system.features.propertyMacros = false;
  const held = { id: 'held', uuid: 'Actor.actor.Item.held', parent: f.actor, system: { quantity: 10 }, flags: {}, update: async () => { throw Error('must not stack'); } };
  f.actor.items.push(held); f.engine.findComponentItems = () => [held];
  crafted = await f.craft(); assert.notEqual(crafted.results[0], held); assert.equal(audit(crafted).applied[0].macro, false); assert.equal(audit(crafted).applied[0].effects, true);
  for (const mutate of [f => f.runtime.effectEmpty = true, f => f.runtime.effects[0].disabled = true]) {
    f = fixture(); f.runtime.macros['Macro.e'] = 'return {}'; mutate(f); crafted = await f.craft(); assert.deepEqual(audit(crafted).applied, []);
  }
  f = fixture(); f.runtime.macros['Macro.e'] = 'return {}'; f.system.components[0].essences = { native: 1 };
  f.system.essenceDefinitions.push({ id: 'native', sourceComponentId: 'a' });
  crafted = await f.craft(); assert.equal(crafted.results[0].effects.length, 2); assert.deepEqual(audit(crafted).applied, []);

  // Empty selections keep the native plain-stack path and create no Sky audit.
  f = fixture(); configure(f, { allowedPropertyIds: [] }); f.recipe.transferEffects = false;
  const plain = { id: 'plain', system: { quantity: 10 }, async update(patch) { for (const [path, value] of Object.entries(patch)) setProperty(this, path, value); } };
  f.engine.findComponentItems = () => [plain]; crafted = await f.craft();
  assert.equal(crafted.results[0], plain); assert.equal(plain.system.quantity, 11); assert.equal(audit(crafted), undefined); assert.equal(f.counters.creates, 0);

  // Failure outputs see only what stock actually consumed. No-check strength and
  // special provenance never expand to ordinary sources of the same property.
  for (const consume of [false, true]) {
    f = fixture(); f.system.craftingCheck.consumption = { consumeIngredientsOnFail: consume }; rollTotal = 1;
    crafted = await f.craft(); assert.equal(crafted.success, false);
    assert.equal(f.counters.consumes, consume ? 1 : 0);
    assert.equal(audit(crafted)?.checkSuccess, consume ? false : undefined);
    assert.equal(crafted.results[0].system.power, consume ? 1 : undefined);
  }
  for (const consume of [false, true]) {
    f = fixture({ mode: 'alchemy', quantities: [3, 1, 2] }); f.system.alchemy.consumeOnFail = consume; rollTotal = 1;
    delete f.sky.systems.s.components.c; f.sky.systems.s.specialComponents.c = ['p']; configure(f, { prioritySpecial: true });
    crafted = await f.brew(['a', 'b', 'c', 'c']); assert.equal(crafted.success, false);
    assert.equal(audit(crafted)?.applied[0]?.sources[0].componentId, consume ? 'c' : undefined);
    assert.equal(f.initialItems[2].deleted === true, consume);
  }
  rollTotal = 17;
  f = fixture({ mode: 'alchemy', quantities: [3, 1, 2] });
  delete f.sky.systems.s.components.c; f.sky.systems.s.specialComponents.c = ['p'];
  configure(f, { prioritySpecial: true });
  crafted = await f.brew(['a', 'b', 'c', 'c']);
  assert.deepEqual(audit(crafted).applied[0].sources.map(row => [row.componentId, row.assignmentType]), [['c', 'special']]);
  assert.equal(audit(crafted).applied[0].sources[0].items[0].quantity, 2);

  // Several awards remain independent, including a potential same-component stack.
  f = fixture(); f.recipe.transferEffects = false;
  const originalResult = f.recipe.resultGroups[0].results[0];
  f.recipe.resultGroups[0].results.push(Object.assign(Object.create(Object.getPrototypeOf(originalResult)), originalResult, { id: 'another', quantity: 2 }));
  f.runtime.macros['Macro.e'] = 'return {"system.power":context.result.id === "another" ? 9 : 3}';
  crafted = await f.craft(); assert.equal(crafted.results.length, 2); assert.equal(f.counters.creates, 2);
  assert.deepEqual(crafted.results.map(row => [row.system.power, row.flags.skybricate.application.resultId]), [[3, 'res'], [9, 'another']]);

  for (const field of ['createThrows', 'effectThrows']) {
    f = fixture(); f.runtime[field] = true;
    await assert.rejects(f.craft()); assert.equal(f.counters.auditUpdates, 0);
  }
  f = fixture(); f.system.features.effectTransfer = false; crafted = await f.craft();
  assert.equal(crafted.results[0].effects.length, 0); assert.equal(audit(crafted).applied[0].macro, true); assert.equal(audit(crafted).applied[0].effects, false);
  f = fixture(); configure(f, { allowedPropertyIds: [] }); f.system.features.essences = false;
  f.system.components[0].essences = { native: 2 }; f.system.essenceDefinitions.push({ id: 'native', propertyMacroUuid: 'Macro.native', sourceComponentId: 'a' });
  f.runtime.macros['Macro.native'] = 'throw Error("essences gate must prevent this")';
  crafted = await f.craft(); assert.equal(crafted.results[0].system.power, undefined); assert.equal(crafted.results[0].effects.length, 0);
  f = fixture(); f.runtime.macros['Macro.e'] = 'return {}'; f.runtime.baseEffects = structuredClone(f.runtime.effects);
  crafted = await f.craft(); assert.equal(crafted.results[0].effects.length, 2); assert.deepEqual(audit(crafted).applied, []);
  f = fixture(); configure(f, { allowedPropertyIds: [] }); f.runtime.sourceFlags = { skybricate: { application: { applied: [{ propertyId: 'old' }] }, other: true } };
  crafted = await f.craft(); assert.equal(audit(crafted), undefined); assert.equal(crafted.results[0].flags.skybricate.other, true);
  // Stock transfer remains one batch. A later unresolved source cannot leave an
  // earlier essence's effects partially transferred, or a completed Sky audit.
  f = fixture(); f.system.components[0].essences = { native: 1 }; f.system.essenceDefinitions.push({ id: 'native', sourceItemUuid: 'Item.bad' });
  const sourceBeforeError = globalThis.fromUuid;
  globalThis.fromUuid = async uuid => { if (uuid === 'Item.bad') throw Error('Source failed'); return sourceBeforeError(uuid); };
  await assert.rejects(f.craft()); assert.equal(f.counters.effects, 0); assert.equal(f.counters.auditUpdates, 0);
  f = fixture(); f.runtime.createEmpty = true; crafted = await f.craft(); assert.deepEqual(crafted.results, []); assert.equal(f.counters.auditUpdates, 0);
  f = fixture(); f.engine._postCraftChatMessage = async () => { throw new Error('Later native error'); };
  await assert.rejects(f.craft()); assert.equal(f.counters.auditUpdates, 0); assert.equal(f.actor.items.at(-1).flags.skybricate, undefined);
  f = fixture(); f.engine._postCraftChatMessage = async ({ createdResults }) => { f.actor.items = f.actor.items.filter(item => !createdResults.includes(item)); };
  crafted = await f.craft(); assert.equal(crafted.results.length, 1); assert.equal(f.counters.auditUpdates, 0);

  // Concurrent attempts retain their own outcomes, selected set and audit state.
  f = fixture({ quantities: [3, 3] }); let release, entered;
  const gate = new Promise(resolve => release = resolve), ready = new Promise(resolve => entered = resolve);
  const runCheck = f.engine._runCraftingCheck; let checks = 0;
  f.engine._runCraftingCheck = async function (...args) { if (++checks === 1) { entered(); await gate; } return runCheck.apply(this, args); };
  const firstAttempt = f.craft(); await ready; configure(f, { outcomeStrengths: { pass: 4, fail: 1 } });
  const secondAttempt = await f.craft(); release(); const firstResult = await firstAttempt;
  assert.equal(audit(firstResult).strength, 1); assert.equal(audit(secondAttempt).strength, 4);
  assert.notEqual(firstResult.results[0], secondAttempt.results[0]); assert.equal(f.counters.consumes, 2);

  // Real run-manager persistence uses JSON-only flags on every write. FINISH
  // must work after deleted stacks, cache loss, and a new manager instance.
  const timed = fixture => {
    fixture.system.requirements.time.enabled = true;
    fixture.recipe.timeRequirement = { minutes: 1 };
  };
  f = fixture({ runs: true, quantities: [1, 1] }); timed(f); configure(f, { outcomeStrengths: { pass: 3, fail: 0.5 } }); rolls = 0;
  assert.equal((await f.craft()).disposition, 'timed-start');
  assert.equal(f.counters.consumes, 1); assert.equal(rolls, 0); assert.equal(f.actor.items.length, 0);
  let active = f.engine.craftingRunManager.getActiveRuns(f.actor)[0];
  assert(active.steps[0].skybricate); assert(!JSON.stringify(active.skybricate).includes('Secret'));
  assert(!JSON.stringify(active.steps[0].skybricate).includes('Secret'));
  assert.equal((await f.craft()).success, false); assert.equal(rolls, 0); assert.equal(f.counters.consumes, 1);
  f.reload(); f.game.time.worldTime = 60; await f.engine.craftingRunManager.processWorldTime(60);
  f.system.essenceDefinitions[0].enabled = false; // START's behaviour gate survives live toggles.
  f.system.requirements.time.enabled = false; // Already armed gates still resume natively.
  crafted = await f.craft();
  assert.equal(crafted.success, true, JSON.stringify(f.warnings)); assert.equal(audit(crafted).strength, 3);
  assert.equal(audit(crafted).applied[0].sources.length, 2); assert.equal(rolls, 1); assert.equal(f.counters.consumes, 1);
  assert.equal(f.counters.auditUpdates, 1); assert.equal(f.engine.craftingRunManager.getActiveRuns(f.actor).length, 0);

  f = fixture({ runs: true }); timed(f); f.runtime.macros['Macro.e'] = '';
  assert.equal((await f.craft()).disposition, 'skybricate-configuration'); assert.equal(f.counters.consumes, 0);
  assert.equal(f.engine.craftingRunManager.getActiveRuns(f.actor).length, 0);
  f = fixture({ runs: true }); timed(f);
  const updateRun = f.engine.craftingRunManager.updateRun;
  f.engine.craftingRunManager.updateRun = function (actor, run) {
    if (run.steps[0].skybricate) throw new Error('Provenance persistence refused');
    return updateRun.call(this, actor, run);
  };
  await assert.rejects(f.craft(), /Provenance persistence refused/); assert.equal(f.counters.consumes, 0);

  f = fixture({ runs: true }); timed(f); configure(f, { outcomeStrengths: { pass: 4, fail: 1 } });
  f.system.essenceDefinitions.push({ id: 'native', propertyMacroUuid: 'Macro.native', sourceComponentId: 'a' });
  f.system.components[0].essences = { e: 99, native: 2 }; f.system.components[1].essences = { native: 3 };
  globalThis.__stockMacroProbe = [];
  f.runtime.macros['Macro.native'] = 'globalThis.__stockMacroProbe.push(["native",context.essenceQuantity]); return {"system.native":context.essenceQuantity};';
  f.runtime.macros['Macro.e'] = 'globalThis.__stockMacroProbe.push(["sky",context.essenceQuantity]); return {"system.power":context.essenceQuantity};';
  await f.craft(); f.reload(); f.game.time.worldTime = 60; f.system.essenceDefinitions[1].enabled = false;
  crafted = await f.craft(); assert.deepEqual(globalThis.__stockMacroProbe, [['native', 5], ['sky', 4]]);
  assert.equal(crafted.results[0].system.native, 5); assert.equal(audit(crafted).applied.length, 1);

  f = fixture({ runs: true, mode: 'alchemy', quantities: [1, 1, 2] }); timed(f);
  assert.equal((await f.brew(['a', 'b', 'c', 'c'])).disposition, 'timed-start');
  assert.equal(f.initialItems[2].system.quantity, 2, 'stock timed START does not spend alchemy extras');
  f.reload(); f.game.time.worldTime = 60; crafted = await f.craft();
  assert.deepEqual(audit(crafted).applied[0].sources.map(source => source.componentId), ['a', 'b']);

  f = fixture({ runs: true, mode: 'routedByCheck' }); timed(f); configure(f, { limitByCheck: true,
    outcomeLimits: { good: 1, bad: 0 }, outcomeStrengths: { good: 2.5, bad: 0.5 } });
  await f.craft(); f.reload(); f.game.time.worldTime = 60; crafted = await f.craft();
  assert.equal(audit(crafted).outcomeId, 'good'); assert.equal(audit(crafted).strength, 2.5);

  for (const corrupt of [run => delete run.skybricate, run => delete run.steps[0].skybricate,
    run => run.steps[0].skybricate.composition[0].componentId = 'b',
    run => run.steps[0].preparedConsumption.consumedSummary[0].quantity = 9,
    (run, fixture) => fixture.sky.systems.s.components.a = [],
    (run, fixture) => configure(fixture, { outcomeStrengths: { pass: 9, fail: 1 } }),
    (run, fixture) => fixture.system.craftingCheck.simple.dc = 11,
    (run, fixture) => fixture.recipe.resultGroups[0].results[0].quantity = 2]) {
    f = fixture({ runs: true }); timed(f); await f.craft();
    const persisted = f.flags['fabricate.fabricate.craftingRuns'];
    corrupt(Object.values(persisted.active)[0], f); f.reload(); f.game.time.worldTime = 100; rolls = 0;
    assert.equal((await f.craft()).disposition, 'skybricate-configuration');
    assert.equal(rolls, 0); assert.equal(f.counters.consumes, 1); assert.equal(f.counters.creates, 0);
  }

  const steps = (fixture, { collapsed = false, mixed = false } = {}) => {
    fixture.system.features.multiStepRecipes = !collapsed;
    fixture.system.requirements.time.enabled = mixed;
    const set = fixture.recipe.ingredientSets[0].toJSON();
    fixture.recipe.steps = [
      { id: 'first', name: 'First', ingredientSets: [set], resultGroups: fixture.recipe.resultGroups, timeRequirement: mixed ? { minutes: 1 } : null },
      { id: 'last', name: 'Last', ingredientSets: [set], resultGroups: fixture.recipe.resultGroups, timeRequirement: mixed ? { minutes: 1 } : null }
    ].map((row, index) => fixture.recipe._normalizeStep(row, index));
  };
  for (const collapsed of [false, true]) for (const mixed of [false, true]) {
    f = fixture({ runs: true, quantities: [3, 3] }); steps(f, { collapsed, mixed }); rolls = 0;
    if (mixed) {
      assert.equal((await f.craft()).success, false); assert.equal(rolls, 0);
      assert.equal(f.counters.consumes, collapsed ? 0 : 1);
      f.reload(); f.game.time.worldTime = collapsed ? 120 : 60;
    }
    crafted = await f.craft();
    if (!collapsed) {
      assert.equal(crafted.success, true, JSON.stringify({ message: crafted.message, warnings: f.warnings, collapsed, mixed })); assert.equal(crafted.results.length, 1); assert.equal(f.counters.auditUpdates, 1);
      f.reload();
      if (mixed) { assert.equal((await f.craft()).disposition, 'timed-start'); f.reload(); f.game.time.worldTime = 120; }
      crafted = await f.craft();
    }
    assert.equal(crafted.success, true, JSON.stringify(f.warnings)); assert.equal(rolls, 2); assert.equal(f.counters.consumes, 2);
    assert.equal(f.counters.creates, 2); assert.equal(f.counters.auditUpdates, 2);
    assert.equal(audit(crafted).applied[0].sources[0].items[0].quantity, 1, 'earlier step consumption is not pooled');
  }
  f = fixture({ runs: true, quantities: [3, 3] }); steps(f, { collapsed: true, awardFirst: true });
  crafted = await f.craft(); assert.equal(crafted.success, true); assert.equal(f.counters.creates, 2); assert.equal(f.counters.auditUpdates, 2);
  assert.equal(f.actor.items.filter(item => item.flags?.skybricate?.application).length, 2);
  f = fixture({ runs: true, quantities: [3, 3] }); steps(f); f.runtime.createEmpty = true;
  crafted = await f.craft(); assert.deepEqual(crafted.results, []); assert.equal(f.counters.auditUpdates, 0);
  f.runtime.createEmpty = false; crafted = await f.craft(); assert.equal(f.counters.auditUpdates, 1);

  // A cancelled FINISH retains the prepared inputs and can resume, without a
  // second consume. Failures, effects/chat errors retain native spent inputs.
  f = fixture({ runs: true }); timed(f); await f.craft(); f.reload(); f.game.time.worldTime = 60;
  const timedCheck = f.engine._runCraftingCheck;
  f.engine._runCraftingCheck = async () => ({ success: false, cancelled: true });
  assert.equal((await f.craft()).cancelled, true); assert.equal(f.counters.consumes, 1); assert.equal(f.counters.auditUpdates, 0);
  f.engine._runCraftingCheck = timedCheck; f.reload(); crafted = await f.craft(); assert.equal(crafted.success, true); assert.equal(f.counters.consumes, 1);
  for (const failure of ['rolled', 'creation', 'effect', 'chat']) {
    f = fixture({ runs: true }); timed(f); await f.craft(); f.reload(); f.game.time.worldTime = 60;
    if (failure === 'rolled') {
      rollTotal = 1;
      crafted = await f.craft(); assert.equal(crafted.success, false); assert.equal(audit(crafted).checkSuccess, false);
      rollTotal = 17;
    } else {
      if (failure === 'creation') f.runtime.createThrows = true;
      else if (failure === 'effect') f.runtime.effectThrows = true;
      else f.engine._postCraftChatMessage = async () => { throw new Error('Chat failed'); };
      await assert.rejects(f.craft()); assert.equal(f.counters.auditUpdates, 0);
    }
    assert.equal(f.counters.consumes, 1);
  }

  // Two independent recipes/runs on the same Actor use their own persisted
  // sources, gate/check outcomes and strength, including after manager reload.
  f = fixture({ runs: true, quantities: [3, 3] }); timed(f);
  const secondRecipe = new Recipe({ ...f.recipe.toJSON(), id: 'second' }); f.manager.recipes.set('second', secondRecipe);
  configure(f, { outcomeStrengths: { pass: 2, fail: 0.5 } });
  f.sky.systems.s.recipeRules.second = { ...structuredClone(f.sky.systems.s.recipeRules.recipe), outcomeStrengths: { pass: 7, fail: 1 } };
  await f.craft(); await f.engine.craft(f.actor, [f.actor], secondRecipe); assert.equal(f.counters.consumes, 2);
  const runIds = f.engine.craftingRunManager.getActiveRuns(f.actor).map(run => run.id); assert.equal(new Set(runIds).size, 2);
  f.reload(); f.game.time.worldTime = 60;
  const secondRun = await f.engine.craft(f.actor, [f.actor], secondRecipe); const firstRun = await f.craft();
  assert.equal(audit(firstRun).strength, 2); assert.equal(audit(secondRun).strength, 7); assert.equal(f.counters.consumes, 2); assert.equal(f.counters.auditUpdates, 2);

  for (const delayed of [false, true]) {
    f = fixture({ runs: true, mode: 'progressive' });
    f.system.craftingCheck.progressive = { rollFormula: '1d20', awardMode: 'equal' };
    f.system.components.find(row => row.id === 'result').difficulty = 10;
    f.recipe.resultGroups = [f.recipe.resultGroups[0]]; f.recipe.outcomeRouting = {}; if (delayed) timed(f); rolls = 0;
    if (delayed) { await f.craft(); assert.equal(rolls, 0); f.reload(); f.game.time.worldTime = 60; }
    crafted = await f.craft(); assert.equal(crafted.success, true, JSON.stringify({ message: crafted.message, warnings: f.warnings }));
    assert.equal(audit(crafted).strength, 1); assert.equal(audit(crafted).outcomeId, null); assert.equal(rolls, 1); assert.equal(f.counters.consumes, 1);
  }
  f = fixture({ runs: true, mode: 'progressive' });
  f.system.craftingCheck.progressive = { rollFormula: '1d20', awardMode: 'equal' };
  f.system.components.find(row => row.id === 'result').difficulty = 100;
  f.recipe.resultGroups = [f.recipe.resultGroups[0]]; f.recipe.outcomeRouting = {};
  crafted = await f.craft(); assert.deepEqual(crafted.results, []); assert.equal(f.counters.auditUpdates, 0);

  // Verify the underlying STOCK seams separately from the runtime integration:
  // one precomputed selected map drives BOTH paths; a local
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
  console.log('PASS stock 1.9.10: immediate/alchemy 9b regressions; real CraftingRunManager JSON persistence/reload/deleted sources, timed start/wait/world time/finish, ordinary/collapsed/mixed steps, separate awards and spends, snapshot gates/native essences, timed alchemy/routed/progressive, cancellation/retry, exceptions, legacy/corrupt/stale guards, persistence refusal, isolated timed runs and no duplicate audit.');
} finally { await rm(temp, { recursive: true, force: true }); }
