import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { emptyData, emptySystem, readData, validateData } from '../scripts/data-model.js';
import { DataStore, registerDataSetting, essenceTransferEnabled } from '../scripts/data-store.js';
import { installCraftAdapter, getCraftAttempt } from '../scripts/craft-adapter.js';
import { mountPropertyPanel } from '../scripts/property-panel.js';
import { consumedSelection } from '../scripts/craft-application.js';
import { fingerprint, runRevision, runBinding, validateRun } from '../scripts/craft-run-context.js';
import { readFileSync } from 'node:fs';

export function craftFixture({ resolveUuid, transfer = true } = {}) {
  const sky = emptyData(), system = { id: 's', name: 'System', resolutionMode: 'simple',
    craftingCheck: { enabled: true, simple: { rollFormula: '1d20' } },
    features: { essences: true, propertyMacros: true, effectTransfer: true },
    components: ['a', 'b', 'c'].map(id => ({ id, name: id })),
    essenceDefinitions: [{ id: 'e', name: 'Essence', propertyMacroUuid: 'Macro.e' }] };
  sky.systems.s = emptySystem();
  Object.assign(sky.systems.s, { properties: { p: { name: 'Secret', description: 'Hidden', essenceId: 'e' } },
    components: { a: ['p'], b: ['p'] } });
  const actor = { uuid: 'Actor.x', items: [] }, captures = [], counters = { rolls: 0, consumes: 0, native: 0, writes: 0 };
  const item = (id, quantity = 3) => { const row = { uuid: `Actor.x.Item.${id}`, componentId: id, parent: actor, system: { quantity } }; actor.items.push(row); return row; };
  const a = item('a'), b = item('b');
  let stored = sky, check = { success: true, outcome: 'pass', data: {}, value: 17 };
  const game = { user: { isGM: true }, modules: new Map([['fabricate', { active: true, version: '1.9.10' }]]),
    fabricate: { getCraftingSystemManager: () => ({ getSystem: () => system }) }, settings: {
      settings: new Map([['fabricate.craftingSystems', { scope: 'world', type: Array }]]),
      get: (ns, key) => ns === 'skybricate' && key === 'transferPropertiesViaEssences' ? transfer
        : structuredClone(ns === 'skybricate' ? stored : [system]),
      set: async (ns, key, value) => { assert.equal(ns, 'skybricate'); stored = structuredClone(value); counters.writes++; }
    } };
  const recipe = { id: 'r', craftingSystemId: 's', transferEffects: false, getExecutionSteps: () => [{}] };
  const engine = {
    recipeManager: { ingredientMatchesItem: (recipe, ingredient, item) => ingredient.match.componentId === item.componentId },
    async craft(actor, sources, recipe, setId, options = {}) {
      counters.native++;
      const selection = this._resolveCraftSelection(sources, {}, recipe, actor);
      const rolled = await this._runCraftingCheck(recipe, actor);
      if (rolled.cancelled || rolled.misconfigured) return { success: false, ...rolled };
      counters.consumes++;
      for (const row of selection.plan) row.item.system.quantity -= row.quantity;
      captures.push(getCraftAttempt(this));
      return { success: rolled.success, results: [], check: rolled };
    },
    async craftAlchemy(actor, sources, submissions, options = {}) {
      if (options.noMatch) { counters.consumes++; return { success: false, disposition: 'no-match' }; }
      await options.beforeCraft?.();
      return this.craft(actor, sources, recipe, null, { ...options, isAlchemyAttempt: true, alchemySubmittedItems: submissions.map(row => row.item) });
    },
    _resolveCraftSelection: () => ({ plan: [{ item: a, quantity: 1 }, { item: b, quantity: 1 }] }),
    _runCraftingCheck: async () => { counters.rolls++; return structuredClone(check); },
    _sourceUuidForEssenceDefinition: () => 'Item.effect'
  };
  const data = new DataStore({ getGame: () => game, idFactory: () => 'new' }), warnings = [];
  const dispose = installCraftAdapter({ engine, getGame: () => game, data,
    resolveUuid: resolveUuid ?? (async uuid => uuid.startsWith('Macro') ? { type: 'script', command: 'return {};' } : { effects: [{ changes: [{}] }] }),
    logger: { warn: (...args) => warnings.push(args) } });
  return { game, system, recipe, engine, actor, a, b, data, captures, counters, warnings, dispose, item,
    get transfer() { return transfer; }, set transfer(value) { transfer = value; },
    get sky() { return stored; }, set sky(value) { stored = value; }, set check(value) { check = value; },
    craft: options => engine.craft(actor, [actor], recipe, null, options) };
}

test('9b strength uses native stable outcome without reroll; no-check ignores a stock pass marker', async () => {
  const f = craftFixture();
  f.sky.systems.s.recipeRules.r = { allowedPropertyIds: ['p'], propertyOrder: [], prioritySpecial: false, limitByCheck: false,
    outcomeLimits: {}, outcomeStrengths: { pass: 2.5, fail: 0.25 } };
  await f.craft(); assert.equal(f.captures[0].strength, 2.5); assert.equal(f.counters.rolls, 1);
  f.check = { success: false, outcome: 'fail' }; await f.craft(); assert.equal(f.captures[1].strength, 0.25);
  f.check = { success: true, outcome: 'unknown' }; assert.equal((await f.craft()).misconfigured, true);
  assert.equal(f.counters.consumes, 2); assert.equal(f.counters.rolls, 3);
  f.system.craftingCheck.enabled = false; f.sky.systems.s.recipeRules.r.outcomeStrengths = {};
  f.check = { success: true, outcome: 'pass' }; await f.craft(); assert.equal(f.captures[2].strength, 1);
  f.system.craftingCheck.enabled = true; f.sky.systems.s.recipeRules.r.outcomeStrengths = { pass: 0, fail: 1 };
  const rolls = f.counters.rolls; assert.equal((await f.craft()).success, false); assert.equal(f.counters.rolls, rolls);
});

test('9b consumed provenance excludes planned-but-unspent, unknown/overdrawn UUIDs and preserves exclusive special sources', () => {
  const composition = ['a', 'b', 'c'].map(componentId => ({ componentId, itemUuid: componentId, actorUuid: 'actor', quantity: 2, kind: componentId === 'c' ? 'extra' : 'ingredient' }));
  const ordinary = { propertyId: 'p', essenceId: 'e', selectionType: 'matched', sources: ['a', 'b'].map(componentId => ({ componentId, assignmentType: 'ordinary' })) };
  const special = { ...ordinary, selectionType: 'special', sources: [{ componentId: 'c', assignmentType: 'special' }] };
  const spent = (...pairs) => pairs.map(([uuid, quantity]) => ({ item: { uuid }, quantity }));
  assert.deepEqual(consumedSelection({ composition, selected: [ordinary] }, spent(['a', 1])), []);
  assert.deepEqual(consumedSelection({ composition, selected: [ordinary] }, spent(['a', 1], ['unknown', 2])), []);
  assert.deepEqual(consumedSelection({ composition, selected: [ordinary] }, spent(['a', 3], ['b', 1])), []);
  const selected = consumedSelection({ composition, selected: [special] }, spent(['a', 1], ['b', 1], ['c', 2]));
  assert.deepEqual(selected[0].sources, [{ componentId: 'c', assignmentType: 'special', items: [{ itemUuid: 'c', actorUuid: 'actor', quantity: 2, kind: 'extra' }] }]);
  assert.deepEqual(consumedSelection({ composition, selected: [special] }, spent(['a', 1], ['b', 1])), []);
  const duplicatePlan = [...composition, { ...composition[0], quantity: 1 }];
  const actual = consumedSelection({ composition: duplicatePlan, selected: [ordinary] }, spent(['a', 2], ['b', 1]));
  assert.equal(actual[0].sources[0].items.length, 1); assert.equal(actual[0].sources[0].items[0].quantity, 2);
});

test('9a captures a native check and pre-consumption composition; provenance stays private, detached and per attempt', async () => {
  const f = craftFixture();
  const result = await f.craft();
  assert.equal(result.success, true); assert.equal(f.counters.rolls, 1); assert.equal(f.counters.consumes, 1);
  assert.equal(f.a.system.quantity, 2); assert.equal(f.captures[0].outcomeId, 'pass');
  assert.deepEqual(f.captures[0].selected, [{ propertyId: 'p', selectionType: 'matched', essenceId: 'e',
    sources: [{ componentId: 'a', assignmentType: 'ordinary' }, { componentId: 'b', assignmentType: 'ordinary' }] }]);
  assert.equal(f.captures[0].composition[0].quantity, 1); assert.equal(getCraftAttempt(f.engine), null);
  assert(!JSON.stringify(result).includes('Secret')); assert(!JSON.stringify(result).includes('propertyId'));
  f.captures[0].selected[0].sources.length = 0;
  await f.craft(); assert.equal(f.captures[1].selected[0].sources.length, 2); assert.equal(f.counters.writes, 0);
  f.dispose();
});

test('9a routed check uses only outcomeId; native cancel/failure/error and zero limits do not reroll', async () => {
  const f = craftFixture(); f.system.resolutionMode = 'routedByCheck';
  f.system.craftingCheck = { routed: { rollFormula: '1d20', type: 'relative', relativeOutcomes: [{ id: 'tier', name: 'Display name' }] } };
  f.sky.systems.s.recipeRules.r = { allowedPropertyIds: ['p'], propertyOrder: [], prioritySpecial: false, limitByCheck: true, outcomeLimits: { tier: 0 } };
  f.check = { success: true, outcome: 'Display name', data: { outcomeId: 'tier' } };
  // The zero limit makes an unlinked property irrelevant to preflight.
  delete f.sky.systems.s.properties.p.essenceId;
  await f.craft(); assert.equal(f.captures[0].outcomeId, 'tier'); assert.deepEqual(f.captures[0].selected, []);
  f.check = { success: true, outcome: 'tier', data: {} };
  assert.equal((await f.craft()).misconfigured, true); assert.equal(f.counters.consumes, 1);
  f.check = { success: false, cancelled: true };
  assert.equal((await f.craft()).cancelled, true); assert.equal(f.counters.consumes, 1);
  f.sky.systems.s.recipeRules.r.limitByCheck = false;
  f.sky.systems.s.properties.p.essenceId = 'e';
  f.check = { success: false, outcome: 'Display name', data: { outcomeId: 'tier' } };
  assert.equal((await f.craft()).success, false); assert.equal(f.counters.rolls, 4); assert.equal(f.counters.consumes, 2);
});

test('9a configuration rejects before roll/consumption; irrelevant catalog and empty allowlist stay usable', async () => {
  for (const mutate of [f => delete f.sky.systems.s.properties.p.essenceId,
    f => f.system.essenceDefinitions[0].enabled = false,
    f => f.system.essenceDefinitions[0].id = 'removed', f => f.system.features.propertyMacros = false,
    f => f.sky.systems.s.recipeRules.r = { allowedPropertyIds: ['p'], propertyOrder: [], prioritySpecial: false, limitByCheck: true, outcomeLimits: { pass: 2 } }]) {
    const f = craftFixture(); mutate(f); const result = await f.craft();
    assert.equal(result.success, false); assert.equal(f.counters.rolls, 0); assert.equal(f.counters.consumes, 0);
    assert(!JSON.stringify(result).includes('Secret'));
  }
  const f = craftFixture(); f.sky.systems.s.properties.unused = { name: 'Unused', description: '' };
  await f.craft(); assert.equal(f.counters.consumes, 1);
  f.sky.systems.s.recipeRules.r = { allowedPropertyIds: [], propertyOrder: [], limitByCheck: false, outcomeLimits: {}, prioritySpecial: false };
  delete f.sky.systems.s.properties.p.essenceId;
  await f.craft(); assert.deepEqual(f.captures[1].selected, []);
});

test('9aAlchemy captures bucketed IDs and extras by native UUID rule; duplicate component never creates a match', async () => {
  const f = craftFixture(); const extra = f.item('c');
  f.sky.systems.s.components.c = ['p'];
  await f.engine.craftAlchemy(f.actor, [f.actor], [{ item: f.a, componentId: 'a' }, { item: f.b, componentId: 'b' },
    { item: extra, componentId: 'c' }, { item: extra, componentId: 'c' }, { item: f.a, componentId: 'a' }]);
  assert.deepEqual(f.captures[0].composition.map(row => [row.componentId, row.quantity, row.kind]), [['a', 1, 'ingredient'], ['b', 1, 'ingredient'], ['c', 2, 'extra']]);
  f.engine._resolveCraftSelection = () => ({ plan: [{ item: f.a, quantity: 2 }] });
  await f.engine.craftAlchemy(f.actor, [f.actor], [{ item: f.a, componentId: 'a' }, { item: f.a, componentId: 'a' }]);
  assert.deepEqual(f.captures[1].selected, []);
  const rolls = f.counters.rolls; const result = await f.engine.craftAlchemy(f.actor, [f.actor], [], { noMatch: true });
  assert.equal(result.disposition, 'no-match'); assert.equal(f.counters.rolls, rolls);
});

test('9c requires a run manager for delayed/multistep; progressive uses no named outcome and strength one', async () => {
  for (const mutate of [f => f.recipe.getExecutionSteps = () => [{}, {}], f => f.recipe.getExecutionSteps = () => [{ timeRequirement: { value: 1 } }]]) {
    const f = craftFixture(); mutate(f); assert.equal((await f.craft()).disposition, 'skybricate-configuration'); assert.equal(f.counters.native, 0);
  }
  const progressive = craftFixture(); progressive.system.resolutionMode = 'progressive';
  await progressive.craft(); assert.equal(progressive.captures[0].strength, 1); assert.equal(progressive.captures[0].outcomeId, null);
  const f = craftFixture(); f.sky = emptyData();
  await f.craft(); assert.equal(f.counters.native, 1); assert.equal(f.captures[0], null);
  const wrapper = f.engine.craft = () => 'other-wrapper'; f.dispose(); assert.equal(f.engine.craft, wrapper);
});

test('9c JSON run provenance binds actor/recipe/configuration and rejects legacy, corrupt or mismatched prepared data', () => {
  const f = craftFixture(), revision = runRevision(f.system, f.sky.systems.s, f.recipe);
  const run = { id: 'run', status: 'waitingTime', actorUuid: f.actor.uuid, recipeId: f.recipe.id, craftingSystemId: 's', currentStepIndex: 0,
    steps: [{ stepId: 'step', status: 'waitingTime', timeGate: { availableAt: 60 }, preparedConsumption: {
      selectedIngredientSetId: 'set', currencySpends: [], resolvedEssences: {}, essenceEnabled: {},
      consumedSummary: [{ itemUuid: f.a.uuid, actorUuid: f.actor.uuid, quantity: 1 }]
    } }] };
  const binding = runBinding(f.actor, f.recipe, revision, run); run.skybricate = binding;
  const composition = [{ componentId: 'a', itemUuid: f.a.uuid, actorUuid: f.actor.uuid, quantity: 1, kind: 'ingredient' }];
  const essenceEnabled = { e: true };
  run.steps[0].skybricate = { index: 0, stepId: 'step', composition, essenceEnabled,
    digest: fingerprint([composition, essenceEnabled]), prepared: fingerprint(run.steps[0].preparedConsumption) };
  const serialized = JSON.parse(JSON.stringify(run));
  assert.deepEqual(validateRun(serialized, binding, f.system).composition, composition);
  for (const mutate of [row => delete row.skybricate, row => row.actorUuid = 'Actor.other',
    row => row.steps[0].skybricate.composition[0].componentId = 'b', row => row.steps[0].preparedConsumption.consumedSummary[0].quantity = 2,
    row => delete row.steps[0].skybricate, row => row.currentStepIndex = 1]) {
    const corrupt = structuredClone(serialized); mutate(corrupt);
    assert.throws(() => validateRun(corrupt, binding, f.system));
  }
  const changed = structuredClone(binding); changed.revision = 'stale';
  assert.throws(() => validateRun(serialized, changed, f.system));
  f.system.essenceDefinitions[0].enabled = false;
  assert.equal(runRevision(f.system, f.sky.systems.s, f.recipe), revision);
  f.sky.systems.s.components.a = [];
  assert.notEqual(runRevision(f.system, f.sky.systems.s, f.recipe), revision);
  assert(!JSON.stringify(run.skybricate).includes('Secret')); assert(!JSON.stringify(run.steps[0].skybricate).includes('Hidden'));
});

test('9c progressive rejects outcome limits before native roll and keeps strength one with empty strength map', async () => {
  const f = craftFixture(); f.system.resolutionMode = 'progressive';
  f.sky.systems.s.recipeRules.r = { allowedPropertyIds: ['p'], propertyOrder: [], prioritySpecial: false,
    limitByCheck: true, outcomeLimits: {} };
  assert.equal((await f.craft()).disposition, 'skybricate-configuration'); assert.equal(f.counters.rolls, 0);
  f.sky.systems.s.recipeRules.r.limitByCheck = false; f.sky.systems.s.recipeRules.r.outcomeStrengths = {};
  await f.craft(); assert.equal(f.captures[0].strength, 1); assert.equal(f.captures[0].outcomeId, null);
});

test('9a concurrent attempts snapshot assignments/checks independently without shared current state', async () => {
  const f = craftFixture(); let release, entered;
  const gate = new Promise(resolve => release = resolve), ready = new Promise(resolve => entered = resolve);
  let count = 0; f.engine._runCraftingCheck = async () => { const current = ++count; if (current === 1) { entered(); await gate; } return { success: true, outcome: 'pass', data: { current } }; };
  const first = f.craft(); await ready;
  f.sky.systems.s.components.b = [];
  await f.craft(); release(); await first;
  assert.deepEqual(f.captures.map(row => [row.checkResult.data.current, row.selected.length]), [[2, 0], [1, 1]]);
});

test('9a unresolved/empty macros and missing effect sources fail preflight before roll or consumption', async () => {
  for (const resolveUuid of [async () => null, async () => ({ type: 'script', command: '' }), async () => { throw new Error('UUID unavailable'); }]) {
    const f = craftFixture({ resolveUuid });
    assert.equal((await f.craft()).success, false); assert.equal(f.counters.rolls + f.counters.consumes, 0);
  }
  const f = craftFixture({ resolveUuid: async () => null }); f.recipe.transferEffects = true;
  delete f.system.essenceDefinitions[0].propertyMacroUuid;
  assert.equal((await f.craft()).success, false); assert.equal(f.counters.rolls + f.counters.consumes, 0);
});

test('craft configuration diagnostics explain prerequisites to GMs without exposing names to players', async () => {
  for (const language of ['en', 'ru']) {
    const translations = JSON.parse(readFileSync(new URL(`../lang/${language}.json`, import.meta.url), 'utf8')).SKYBRICATE;
    for (const [code, mutate] of [
      ['EssenceRequired', f => delete f.sky.systems.s.properties.p.essenceId],
      ['MacroUnavailable', f => f.system.essenceDefinitions[0].propertyMacroUuid = 'Item.not-a-macro'],
      ['EffectUnavailable', f => { f.system.features.propertyMacros = false; f.recipe.transferEffects = true; }],
      ['BehaviourRequired', f => f.system.features.propertyMacros = false]
    ]) {
      const f = craftFixture({ resolveUuid: async () => null }); mutate(f);
      f.game.i18n = { localize: key => key.split('.').slice(1).reduce((value, part) => value?.[part], translations) ?? key };
      const gm = await f.craft(); assert.equal(gm.message, translations.Craft[code]);
      assert.equal(f.counters.rolls + f.counters.consumes, 0);
      f.game.user.isGM = false;
      const player = await f.craft(); assert.equal(player.message, translations.Craft.AskGM);
      assert(!JSON.stringify(player).includes('Secret')); assert.equal(f.warnings.length, 1);
      assert.equal(f.counters.rolls + f.counters.consumes, 0); f.dispose();
    }
  }
});

test('schema6 keeps schema5 rules/knowledge and private links validate IDs/uniqueness without native writes', async () => {
  const f = craftFixture(); const old = structuredClone(f.sky); old.schemaVersion = 5; delete old.systems.s.properties.p.essenceId;
  old.systems.s.recipeRules.r = { allowedPropertyIds: ['p'], propertyOrder: ['p'], limitByCheck: false, outcomeLimits: {}, prioritySpecial: false };
  f.sky = old;
  const migrated = f.data.getSnapshot(); assert.equal(migrated.schemaVersion, 7);
  assert.deepEqual(migrated.systems.s.recipeRules, old.systems.s.recipeRules); assert.deepEqual(f.sky, old);
  await f.data.updateProperty('s', 'p', { essenceId: 'e' }); assert.equal(f.sky.schemaVersion, 7);
  await assert.rejects(f.data.createProperty('s', { name: 'Duplicate', essenceId: 'e' }));
  await assert.rejects(f.data.updateProperty('s', 'p', { essenceId: 'missing' }));
  await f.data.updateProperty('s', 'p', { essenceId: null }); assert.equal(f.sky.systems.s.properties.p.essenceId, undefined);
  const wrong = structuredClone(old); wrong.systems.s.properties.p.essenceId = 'e'; assert.throws(() => readData(wrong));
  for (const essenceId of ['', '__proto__', 3]) { const data = f.data.getSnapshot(); data.systems.s.properties.p.essenceId = essenceId; assert.throws(() => validateData(data)); }
});

test('GM property editor selects essence of current system; removed links survive display and can be cleared', async () => {
  const f = craftFixture(), window = new Window(), target = window.document.createElement('div'); window.document.body.append(target);
  const panel = mountPropertyPanel({ target, systemId: 's', data: f.data, canWrite: () => true, text: key => key });
  target.querySelector('[data-sky-action="edit"]').click();
  const select = target.querySelector('[data-sky-field="essenceId"]'); assert.equal(select.value, 'e');
  select.value = ''; target.querySelector('[data-sky-action="save"]').click();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(f.sky.systems.s.properties.p.essenceId, undefined);
  f.sky.systems.s.properties.p.essenceId = 'removed'; target.querySelector('[data-sky-action="refresh"]').click(); target.querySelector('[data-sky-action="edit"]').click();
  assert.equal(target.querySelector('[data-sky-field="essenceId"]').value, 'removed');
  panel.dispose(); window.happyDOM.abort();
});

test('essence transfer registers a visible Boolean world setting defaulting off and reads strictly true', () => {
  const registrations = [];
  registerDataSetting({ register: (...args) => registrations.push(args) });
  const [ns, key, config] = registrations.find(([, key]) => key === 'transferPropertiesViaEssences');
  assert.equal(ns, 'skybricate'); assert.equal(config.scope, 'world'); assert.equal(config.config, true);
  assert.equal(config.type, Boolean); assert.equal(config.default, false);
  for (const value of [undefined, false, 0, 1, 'true', {}, true]) {
    const game = { settings: { get: (namespace, name) => { assert.equal(namespace, ns); assert.equal(name, key); return value; } } };
    assert.equal(essenceTransferEnabled(game), value === true);
  }
  for (const language of ['en', 'ru']) {
    const strings = JSON.parse(readFileSync(new URL('../lang/'+language+'.json', import.meta.url), 'utf8')).SKYBRICATE.Craft;
    for (const key of ['TransferSetting', 'TransferSettingHint', 'TransferModeChanged']) assert(strings[key]?.trim());
  }
});

test('transfer OFF captures property selection without essence prerequisites or behaviour resolution', async () => {
  for (const transfer of [undefined, false, 'true', 1]) {
    const f = craftFixture({ transfer: false, resolveUuid: () => { throw new Error('Sky must not resolve essence actions'); } });
    f.transfer = transfer;
    delete f.sky.systems.s.properties.p.essenceId; f.system.features = {}; f.system.essenceDefinitions = [];
    const before = structuredClone(f.sky);
    const basic = await f.craft(); assert.equal(basic.success, true, JSON.stringify([basic, f.warnings]));
    assert.equal((await f.engine.craftAlchemy(f.actor, [f.actor], [{ item: f.a, componentId: 'a' }, { item: f.b, componentId: 'b' }])).success, true);
    assert(f.captures.every(attempt => attempt.transfer === false && attempt.selected[0].propertyId === 'p' && !Object.hasOwn(attempt.selected[0], 'essenceId'))); assert.equal(f.counters.rolls, 2); assert.equal(f.counters.consumes, 2);
    assert.equal(f.counters.writes, 0); assert.deepEqual(f.sky, before);
  }
});

test('live transfer toggle affects new attempts and preserves current async check snapshot in either direction', async () => {
  for (const initial of [false, true]) {
    const f = craftFixture({ transfer: initial });
    const check = f.engine._runCraftingCheck;
    f.engine._runCraftingCheck = async function (...args) { f.transfer = !initial; return check.apply(this, args); };
    await f.craft(); assert.equal(f.captures[0].transfer, initial);
    f.engine._runCraftingCheck = check;
    await f.craft(); assert.equal(f.captures[1].transfer, !initial);
    assert.equal(f.counters.rolls, 2); assert.equal(f.counters.consumes, 2);
  }
  const f = craftFixture({ transfer: false }); delete f.sky.systems.s.properties.p.essenceId;
  assert.equal((await f.craft()).success, true); f.transfer = true;
  assert.equal((await f.craft()).disposition, 'skybricate-configuration');
  assert.equal(f.counters.rolls, 1); assert.equal(f.counters.consumes, 1);
});

test('alchemy fixes transfer mode before native async work in either direction', async () => {
  for (const initial of [false, true]) {
    const f = craftFixture({ transfer: initial });
    await f.engine.craftAlchemy(f.actor, [f.actor], [{ item: f.a, componentId: 'a' }, { item: f.b, componentId: 'b' }], {
      beforeCraft: async () => { f.transfer = !initial; }
    });
    assert.equal(f.captures[0].transfer, initial); assert.equal(f.counters.consumes, 1);
  }
});
