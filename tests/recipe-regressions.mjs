import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { DataStore } from '../scripts/data-store.js';
import { emptyData, emptyRecipeRules, readData } from '../scripts/data-model.js';
import { selectProperties } from '../scripts/property-selection.js';
import { persistedRecipes, recipeContext, recipeOutcomes } from '../scripts/recipe-contract.js';
import { mountRecipePanel } from '../scripts/recipe-panel.js';
import { createRecipeApplication } from '../scripts/recipe-adapter.js';
import { installManagerAdapter } from '../scripts/manager-adapter.js';
import { readable, hookBus, settleDOM } from './helpers/manager-fixture.mjs';

const settle = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
const rules = ids => ({ ...emptyRecipeRules(), allowedPropertyIds: [...ids], propertyOrder: [...ids] });
async function fixture() {
  let stored = emptyData(), next = 0, writes = 0, gate = null, reject = false;
  const systems = ['a', 'b'].map(id => ({ id, name: id, resolutionMode: 'simple', craftingCheck: { enabled: true, simple: { rollFormula: "1d20" } },
    components: [{ id: 'c' }, { id: 'd' }] }));
  let recipes = ['a1', 'a2', 'b1'].map(id => ({ id, name: '<img src=x>', craftingSystemId: id[0], enabled: false }));
  const game = { user: { isGM: true }, modules: new Map([['fabricate', { active: true, version: '1.9.10' }]]),
    actors: new Map([['actor', {}]]), i18n: { localize: key => key.split('.').at(-1) }, settings: {
      settings: new Map(['craftingSystems', 'recipes'].map(key => [`fabricate.${key}`, { scope: 'world', type: Array }])),
      get: (ns, key) => structuredClone(ns === 'skybricate' ? stored : key === 'recipes' ? recipes : systems),
      set: async (ns, key, value) => { assert.equal(ns, 'skybricate'); if (gate) await gate;
        if (reject) throw new Error('Write failed'); stored = structuredClone(value); writes++; }
    } };
  const data = new DataStore({ getGame: () => game, idFactory: () => `p${++next}` });
  await data.createProperty('a', { name: '<script>', description: '<img>' });
  await data.createProperty('a', { name: 'Second' }); await data.createProperty('b', { name: 'Other' });
  await data.setComponentAssignments('a', 'c', { ordinary: ['p1', 'p2'] });
  await data.setComponentAssignments('a', 'd', { ordinary: ['p1', 'p2'] });
  return { game, data, systems, get recipes() { return recipes; }, set recipes(value) { recipes = value; },
    get stored() { return structuredClone(stored); }, set stored(value) { stored = value; }, get writes() { return writes; },
    set gate(value) { gate = value; }, set reject(value) { reject = value; } };
}

test('recipe allowlist filters before shared limit; absence preserves legacy, empty denies all, special sources unchanged', async () => {
  const f = await fixture(), system = f.data.getSnapshot().systems.a;
  const select = recipeRules => selectProperties({ system, componentIds: ['c', 'd'], recipeRules, outcome: 'pass' });
  assert.deepEqual(select({}).map(p => p.propertyId), ['p1', 'p2']);
  assert.deepEqual(select(rules([])), []);
  assert.deepEqual(select({ ...rules(['p2']), limitByCheck: true, outcomeLimits: { pass: 1 } }).map(p => p.propertyId), ['p2']);
  system.components.c = ['p2']; system.specialComponents.c = ['p1'];
  const selected = select({ ...rules(['p1', 'p2']), prioritySpecial: true });
  assert.deepEqual(selected[0], { propertyId: 'p1', selectionType: 'special', sources: [{ componentId: 'c', assignmentType: 'special' }] });
  assert.deepEqual(select({ ...rules(['p2']), prioritySpecial: true }).map(p => p.propertyId), ['p2']);
  assert.deepEqual(selectProperties({ system, componentIds: [], recipeRules: rules(['p1']) }), []);
  for (const allowedPropertyIds of [['missing'], ['p1', 'p1'], null, {}]) assert.throws(() => select({ allowedPropertyIds }));
});

test('schema 4 migration preserves knowledge and assignments without writes; only successful recipe save persists schema 7', async () => {
  const f = await fixture(); await f.data.setPropertyKnowledge('actor', 'a', 'c', 'p1', true);
  const old = f.stored; old.schemaVersion = 4; for (const system of Object.values(old.systems)) delete system.recipeRules;
  f.stored = old; const writes = f.writes, snapshot = f.data.getSnapshot();
  assert.equal(snapshot.schemaVersion, 7); assert.deepEqual(snapshot.knowledge, old.knowledge); assert.deepEqual(snapshot.systems.a.recipeRules, {});
  assert.deepEqual(f.stored, old); assert.equal(f.writes, writes);
  f.reject = true; await assert.rejects(f.data.configureRecipeRules('a', 'a1', rules(['p1']))); assert.deepEqual(f.stored, old);
  f.reject = false; await f.data.configureRecipeRules('a', 'a1', rules(['p1']));
  assert.equal(f.stored.schemaVersion, 7); assert.deepEqual(f.stored.knowledge, old.knowledge);
  for (const mutate of [v => v.systems.a.recipeRules.a1.extra = 1,
    v => v.systems.a.recipeRules.a1.allowedPropertyIds = ['missing'],
    v => v.systems.a.recipeRules.a1.outcomeLimits = { pass: -1 }]) {
    const value = f.stored; mutate(value); assert.throws(() => readData(value));
  }
});

test('recipe rules are isolated; rename keeps IDs; deletion prunes both lists and knowledge atomically', async () => {
  const f = await fixture(); await f.data.configureRecipeRules('a', 'a1', rules(['p1', 'p2']));
  await f.data.configureRecipeRules('a', 'a2', rules(['p2'])); await f.data.configureRecipeRules('b', 'b1', rules(['p3']));
  await f.data.setPropertyKnowledge('actor', 'a', 'c', 'p1', true);
  await f.data.updateProperty('a', 'p1', { name: 'New' }); assert.deepEqual(f.stored.systems.a.recipeRules.a1.allowedPropertyIds, ['p1', 'p2']);
  const before = f.stored, writes = f.writes; f.reject = true;
  await assert.rejects(f.data.deleteProperty('a', 'p1')); assert.deepEqual(f.stored, before);
  f.reject = false; await f.data.deleteProperty('a', 'p1'); assert.equal(f.writes, writes + 1);
  assert.deepEqual(f.stored.systems.a.recipeRules.a1, rules(['p2'])); assert.deepEqual(f.stored.knowledge, {});
  assert.deepEqual(f.stored.systems.a.recipeRules.a2, before.systems.a.recipeRules.a2);
  assert.deepEqual(f.stored.systems.b, before.systems.b);
});

test('native outcomes are pass/fail or stable active relative/fixed tier IDs; unsupported limits fail closed', async () => {
  const f = await fixture(); assert.deepEqual(recipeOutcomes(f.systems[0]).map(row => row.id), ['fail', 'pass']);
  for (const type of ['relative', 'fixed']) {
    Object.assign(f.systems[0], { resolutionMode: 'alchemy', alchemy: { checkMode: 'tiered' }, craftingCheck: { routed: {
      type, rollFormula: "1d20", relativeOutcomes: [{ id: 'relative', name: 'Same' }], fixedOutcomes: [{ id: 'fixed', name: 'Same' }]
    } } });
    assert.deepEqual(recipeOutcomes(f.systems[0]).map(row => row.id), [type]);
    const value = { ...rules(['p1']), limitByCheck: true, outcomeLimits: { [type]: 0 } };
    await f.data.configureRecipeRules('a', 'a1', value);
    f.systems[0].craftingCheck.routed[type + 'Outcomes'][0].name = 'Renamed';
    await f.data.configureRecipeRules('a', 'a1', value);
    for (const outcomeLimits of [{}, { wrong: 2 }, { [type]: -1 }, { [type]: 0.2 }, { [type]: Number.MAX_SAFE_INTEGER + 1 }]) {
      await assert.rejects(f.data.configureRecipeRules('a', 'a1', { ...value, outcomeLimits }));
    }
  }
  for (const system of [{ ...f.systems[0], alchemy: { checkMode: 'none' } }, { resolutionMode: 'simple', craftingCheck: { enabled: false } }, { resolutionMode: 'progressive' }]) {
    Object.assign(f.systems[0], system); assert.deepEqual(recipeOutcomes(f.systems[0]), []);
    await assert.rejects(f.data.configureRecipeRules('a', 'a1', { ...rules([]), limitByCheck: true }));
    await f.data.configureRecipeRules('a', 'a1', rules([]));
  }
});

test('recipe writes recheck GM, context, optimistic rules, deletions and latest snapshot inside queue', async () => {
  const f = await fixture(), context = recipeContext(f.game, 'a', 'a1');
  let release; f.gate = new Promise(resolve => { release = resolve; });
  const first = f.data.updateProperty('a', 'p1', { name: 'New' }); await settle();
  const second = f.data.configureRecipeRules('a', 'a1', rules(['p1']), { expectedContext: context.revision });
  f.recipes[0].name = 'Changed'; release(); await first;
  await assert.rejects(second, /changed/); assert.equal(f.stored.systems.a.properties.p1.name, 'New');
  f.gate = null;
  await f.data.configureRecipeRules('a', 'a1', rules(['p2']), { expectedRules: null });
  await assert.rejects(f.data.configureRecipeRules('a', 'a1', rules(['p1']), { expectedRules: null }), /changed/);
  await assert.rejects(f.data.configureRecipeRules('a', 'a1', rules(['p1']), { canWrite: () => false }));
  await assert.rejects(f.data.configureRecipeRules('b', 'a1', rules([])));
  f.game.user.isGM = false; await assert.rejects(f.data.configureRecipeRules('a', 'a1', rules([]))); f.game.user.isGM = true;
  f.recipes = f.recipes.filter(row => row.id !== 'a1');
  await assert.rejects(f.data.configureRecipeRules('a', 'a1', rules([])));
  await f.data.reconcileRecipeRules(); assert.equal(f.stored.systems.a.recipeRules.a1, undefined);
  f.recipes.push({ id: 'copy', craftingSystemId: 'a', name: 'Copied' });
  assert.equal(f.data.getSnapshot().systems.a.recipeRules.copy, undefined);
  f.game.settings.settings.get('fabricate.recipes').type = Object; assert.throws(() => persistedRecipes(f.game));
});

test('optional check availability follows stock formula/feature gates, not display names', async () => {
  const simple = { resolutionMode: 'simple', features: { craftingChecks: true }, craftingCheck: { enabled: false, simple: { rollFormula: '1d20' } } };
  assert.deepEqual(recipeOutcomes(simple).map(row => row.id), ['fail', 'pass']);
  simple.features.craftingChecks = false; assert.deepEqual(recipeOutcomes(simple), []);
  simple.resolutionMode = 'routedByIngredients'; assert.deepEqual(recipeOutcomes(simple).map(row => row.id), ['fail', 'pass']);
  for (const formula of ['', '   ', '@craftingmod', '1d20 + @craftingmod']) {
    simple.craftingCheck.simple.rollFormula = formula; assert.deepEqual(recipeOutcomes(simple), []);
  }
  simple.resolutionMode = 'alchemy'; simple.alchemy = { checkMode: 'simple' }; simple.craftingCheck.simple.rollFormula = '1d20';
  assert.deepEqual(recipeOutcomes(simple).map(row => row.id), ['fail', 'pass']);
  assert.throws(() => recipeOutcomes({ resolutionMode: 'future' }));
  const f = await fixture(), expectedContext = recipeContext(f.game, 'a', 'a1').revision;
  f.systems[0].features = { craftingChecks: true };
  await assert.rejects(f.data.configureRecipeRules('a', 'a1', rules([]), { expectedContext }), /changed/);
});

test('recipe panel orders and saves exact recipe separately, persists zero, reloads and rejects stale/invalid edits', async t => {
  const f = await fixture(), window = new Window(), target = window.document.createElement('div'); window.document.body.append(target);
  let allowed = true;
  const panel = mountRecipePanel({ target, getGame: () => f.game, data: f.data, systemId: 'a', recipeId: 'a1', canWrite: () => allowed, text: key => key });
  t.after(() => { panel.dispose(); window.happyDOM.abort(); });
  const action = key => target.querySelector(`[data-sky-recipe-action="${key}"]`);
  const toggle = key => target.querySelector(`[data-sky-recipe-toggle="${key}"]`);
  assert.equal(target.querySelector('img'), null); assert.match(target.textContent, /Unconfigured/);
  action('add').click(); action('add').click(); action('down').click();
  toggle('LimitByCheck').checked = true; toggle('PrioritySpecial').checked = true;
  action('save').click(); await settle();
  assert.deepEqual(f.stored.systems.a.recipeRules.a1, { ...rules(['p2', 'p1']), limitByCheck: true, prioritySpecial: true, outcomeLimits: { fail: 0, pass: 0 }, outcomeStrengths: { fail: 1, pass: 1 } });
  assert.equal(f.stored.systems.a.recipeRules.a2, undefined);
  panel.reload(); assert.equal(toggle('PrioritySpecial').checked, true);
  const input = target.querySelector('[data-sky-outcome="pass"]'); input.value = '1.5'; const before = f.stored;
  action('save').click(); await settle(); assert.deepEqual(f.stored, before); assert.match(target.textContent, /InvalidLimit/);
  input.value = '3'; f.recipes[0].name = 'Changed'; action('save').click(); await settle();
  assert.deepEqual(f.stored, before); assert.match(target.textContent, /changed/);
  action('reload').click(); while (action('remove')) action('remove').click(); action('save').click(); await settle();
  assert.deepEqual(f.stored.systems.a.recipeRules.a1.allowedPropertyIds, []);
  allowed = false; action('add').click(); action('save').click(); await settle(); assert.deepEqual(f.stored.systems.a.recipeRules.a1.allowedPropertyIds, []);
});

test('schema7 reads schema6 losslessly and outcome strength is separate, exact and positive', async () => {
  const f = await fixture(); await f.data.configureRecipeRules('a', 'a1', rules(['p1']));
  const old = f.stored; old.schemaVersion = 6; f.stored = old;
  const migrated = f.data.getSnapshot(); assert.equal(migrated.schemaVersion, 7);
  assert.deepEqual(migrated.systems, old.systems); assert.deepEqual(f.stored, old);
  const strengths = { fail: 0.25, pass: 4.5 };
  await f.data.configureRecipeRules('a', 'a1', { ...rules(['p1']), outcomeStrengths: strengths });
  assert.equal(f.stored.schemaVersion, 7); assert.equal(f.stored.systems.a.recipeRules.a1.limitByCheck, false);
  assert.deepEqual(f.stored.systems.a.recipeRules.a1.outcomeStrengths, strengths);
  for (const outcomeStrengths of [{}, { pass: 1 }, { pass: 1, fail: 1, extra: 2 }, ...[0, -1, Infinity, NaN, '2', null].map(value => ({ pass: value, fail: 1 }))]) {
    await assert.rejects(f.data.configureRecipeRules('a', 'a1', { ...rules(['p1']), outcomeStrengths }));
  }
  const wrongVersion = structuredClone(old); wrongVersion.systems.a.recipeRules.a1.outcomeStrengths = strengths;
  assert.throws(() => readData(wrongVersion));
  f.systems[0].craftingCheck.enabled = false;
  await assert.rejects(f.data.configureRecipeRules('a', 'a1', { ...rules(['p1']), outcomeStrengths: strengths }));
  await f.data.configureRecipeRules('a', 'a1', { ...rules(['p1']), outcomeStrengths: {} });
});

test('GM strength inputs remain editable with count limit off; invalid and changed outcomes require correction/reload', async t => {
  const f = await fixture(), window = new Window(), target = window.document.createElement('div'); window.document.body.append(target);
  const panel = mountRecipePanel({ target, getGame: () => f.game, data: f.data, systemId: 'a', recipeId: 'a1', canWrite: () => true, text: key => key });
  t.after(() => { panel.dispose(); window.happyDOM.abort(); });
  const save = () => target.querySelector('[data-sky-recipe-action="save"]').click();
  const strength = outcome => target.querySelector(`[data-sky-strength="${outcome}"]`);
  assert.equal(strength('pass').value, '1'); assert.equal(strength('pass').disabled, false);
  assert.equal(target.querySelector('[data-sky-outcome="pass"]').disabled, true);
  strength('pass').value = '2.5'; strength('fail').value = '0.25'; save(); await settle();
  assert.deepEqual(f.stored.systems.a.recipeRules.a1.outcomeStrengths, { fail: 0.25, pass: 2.5 });
  const before = f.stored; strength('pass').value = '0'; save(); await settle();
  assert.deepEqual(f.stored, before); assert.match(target.textContent, /InvalidStrength/);
  strength('pass').value = '3'; f.systems[0].craftingCheck.enabled = false; save(); await settle();
  assert.deepEqual(f.stored, before); assert.match(target.textContent, /changed/);
  panel.reload(); assert.equal(strength('pass'), null); assert.match(target.textContent, /NoOutcomes/);
  save(); await settle(); assert.deepEqual(f.stored.systems.a.recipeRules.a1.outcomeStrengths, {});
});

test('row adapter binds IDs, rejects changed system/stale rows, avoids duplicates, cleans up deleted recipes', async t => {
  const f = await fixture(), window = new Window(), root = window.document.createElement('div'); window.document.body.append(root);
  const row = id => `<li class="manager-recipe-row" data-recipe-id="${id}"><span><button class="manager-recipe-edit" data-recipe-edit="${id}" type="button">Edit</button></span></li>`;
  root.innerHTML = row('a1') + row('a2'); const hooks = hookBus(), selectedSystemId = readable('a');
  const viewState = readable({ selectedSystem: { id: 'a', resolutionMode: 'simple' } });
  const app = { options: { id: 'fabricate-crafting-system-manager' }, element: root, _adminStore: { selectedSystemId, viewState } };
  const opens = [], warnings = [];
  const dispose = installManagerAdapter({ hooks, getGame: () => f.game, data: f.data, compatible: () => true,
    notifications: () => ({ warn: message => warnings.push(message) }), Observer: window.MutationObserver,
    openRecipeRules: (...args) => opens.push(args) });
  const flush = async () => { await settle(); await window.happyDOM.waitUntilComplete(); };
  t.after(() => { dispose(); window.happyDOM.abort(); });
  hooks.fire('renderApplicationV2', app, root); await flush(); assert.equal(root.querySelectorAll('[data-skybricate-recipe]').length, 2);
  const button = root.querySelector('[data-skybricate-recipe="a2"]'); button.click(); await flush();
  assert.deepEqual(opens[0].slice(0, 2), ['a', 'a2']); assert.equal(opens[0][2](), true);
  hooks.fire('renderApplicationV2', app, root); await flush(); assert.equal(root.querySelectorAll('[data-skybricate-recipe]').length, 2);
  selectedSystemId.set('b'); button.click(); await flush(); assert.equal(opens.length, 1); assert.equal(opens[0][2](), false);
  root.innerHTML = row('b1'); viewState.set({ selectedSystem: { id: 'b', resolutionMode: 'simple' } }); await flush();
  root.querySelector('[data-skybricate-recipe]').click(); await flush(); assert.deepEqual(opens[1].slice(0, 2), ['b', 'b1']);
  await f.data.configureRecipeRules('b', 'b1', rules(['p3'])); f.recipes = f.recipes.filter(row => row.id !== 'b1'); root.replaceChildren();
  hooks.fire('updateSetting', { key: 'fabricate.recipes' }); await flush(); assert.equal(f.stored.systems.b.recipeRules.b1, undefined);
  hooks.fire('closeApplicationV2', app); assert.equal(opens[1][2](), false);
  assert.deepEqual(warnings, []);
});

test('recipe ApplicationV2 renders only a GM saved context and disposes its panel', async () => {
  const f = await fixture(); class Base { constructor() {} _onClose() {} _onRender() {} async close() {} }
  const Application = createRecipeApplication({ ApplicationV2: Base, getGame: () => f.game, getData: () => f.data, compatible: () => true });
  const app = new Application({ systemId: 'a', recipeId: 'a1' }); assert.equal(app._canRender(), undefined);
  f.game.user.isGM = false; assert.equal(app._canRender(), false); f.game.user.isGM = true;
  const window = new Window(), root = window.document.createElement('div');
  app._replaceHTML(null, root); window.document.body.append(root); app._onRender();
  assert(root.querySelector('[data-sky-recipe-rules]'));
  root.querySelector('[data-sky-recipe-action="add"]').click(); app._replaceHTML(null, root); app._onRender();
  assert.equal(root.querySelector('select[data-sky-recipe-index="0"]').value, 'p1');
  assert.equal(root.children.length, 1); await app.close(); assert.equal(root.children.length, 0); window.happyDOM.abort();
});
