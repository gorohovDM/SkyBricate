import test from 'node:test';
import assert from 'node:assert/strict';
import { craftFixture } from './craft-regressions.mjs';
import { DataStore } from '../scripts/data-store.js';
import { installCraftDiscovery } from '../scripts/craft-discovery.js';
import { runRevision } from '../scripts/craft-run-context.js';

function fixture() {
  const f = craftFixture(), handlers = new Map(), warnings = [];
  f.actor.id = 'x'; f.game.actors = [f.actor]; f.game.actors.get = id => f.game.actors.find(actor => actor.id === id);
  f.game.user.id = 'gm'; f.game.users = { activeGM: f.game.user };
  const hooks = { on: (name, fn) => handlers.set(name, fn) };
  const delivery = () => handlers.get('updateItem')(item, { 'flags.skybricate.application': { arbitrary: 'ignored' } });
  const item = { id: 'result', uuid: 'Actor.x.Item.result', parent: f.actor, flags: { skybricate: {} },
    async update(patch) { for (const [key, value] of Object.entries(patch)) this.flags.skybricate[key.split('.').at(-1)] = structuredClone(value); } };
  f.actor.items.push(item);
  const source = componentId => ({ componentId, assignmentType: 'ordinary',
    items: [{ itemUuid: `Actor.x.Item.${componentId}`, actorUuid: f.actor.uuid, quantity: 1, kind: 'ingredient' }] });
  const audit = { version: 1, discoveryVersion: 1, itemUuid: item.uuid, actorUuid: f.actor.uuid,
    craftingSystemId: 's', recipeId: 'r', craftSuccess: true, checkSuccess: false,
    applied: [{ propertyId: 'p', essenceId: 'e', selectionType: 'matched', macro: true, effects: false, sources: ['a', 'b'].map(source) }] };
  const service = installCraftDiscovery({ hooks, getGame: () => f.game, data: f.data, logger: { warn: value => warnings.push(value) } });
  item.flags.skybricate.application = structuredClone(audit);
  return Object.assign(f, { itemResult: item, audit, warnings, delivery, handlers, service,
    known: (component = 'a') => f.sky.knowledge.x?.s?.[component] ?? [],
    discover: async () => { delivery(); await service.settle(); } });
}

test('10 activeGM discovers actual successful award despite a failed check; isolates IDs, keeps run revision and manual GM control', async () => {
  const f = fixture(), revision = runRevision(f.system, f.sky.systems.s, f.recipe);
  await f.discover();
  assert.deepEqual(f.known(), ['p']); assert.deepEqual(f.known('b'), ['p']); assert.deepEqual(f.known('c'), []);
  assert.equal(runRevision(f.system, f.sky.systems.s, f.recipe), revision);
  assert.deepEqual(Object.keys(f.sky.knowledge), ['x']);
  f.game.user = { id: 'other-gm', isGM: true };
  await f.data.setPropertyKnowledge('x', 's', 'a', 'p', false);
  f.game.user = f.game.users.activeGM; await f.discover(); assert.deepEqual(f.known(), []);
  await f.data.setComponentProperties('s', 'a', []); await f.data.setComponentProperties('s', 'a', ['p']);
  await f.discover(); assert.deepEqual(f.known(), []);
  const fresh = new DataStore({ getGame: () => f.game }); await fresh.discoverCraftKnowledge(f.itemResult); assert.deepEqual(f.known(), []);
});

test('10 special path discovers only special source; effect-only is eligible and source assignment must still exist', async () => {
  const f = fixture(); f.sky.systems.s.specialComponents.c = ['p'];
  const p = f.itemResult.flags.skybricate.application.applied[0];
  p.selectionType = 'special'; p.macro = false; p.effects = true;
  p.sources = [{ componentId: 'c', assignmentType: 'special', items: [{ itemUuid: 'Item.c', quantity: 1, kind: 'extra' }] }];
  await f.discover(); assert.deepEqual(f.known(), []); assert.deepEqual(f.known('b'), []); assert.deepEqual(f.known('c'), ['p']);
});

test('10 rejects unsuccessful, historical, copied, detached, malformed, no-op and stale source awards without trusting hook payload', async () => {
  const invalid = [
    f => f.itemResult.flags.skybricate.application.craftSuccess = false,
    f => delete f.itemResult.flags.skybricate.application.discoveryVersion,
    f => f.itemResult.flags.skybricate.application.itemUuid = 'Actor.x.Item.old',
    f => f.itemResult.flags.skybricate.application.actorUuid = 'Actor.other',
    f => f.itemResult.flags.skybricate.application.craftingSystemId = 'other',
    f => f.itemResult.flags.skybricate.application.applied = [],
    f => f.itemResult.flags.skybricate.application.applied[0].macro = false,
    f => f.itemResult.flags.skybricate.application.applied[0].sources.pop(),
    f => f.itemResult.flags.skybricate.application.applied[0].sources[0].items[0].quantity = 0,
    f => f.itemResult.flags.skybricate.application.applied[0].propertyId = '__proto__',
    f => f.sky.systems.s.components.b = [],
    f => f.sky.systems.s.properties.p.essenceId = 'changed',
    f => f.actor.items = f.actor.items.filter(item => item !== f.itemResult),
    f => f.game.actors = Object.assign([], { get: () => undefined })
  ];
  for (const change of invalid) { const f = fixture(); change(f); await f.discover(); assert.deepEqual(f.sky.knowledge, {}); }
});

test('10 player delivery uses activeGM hook; missing/other GM waits for user change scan, skips historical audits', async () => {
  for (const active of [null, { id: 'another', isGM: true }]) {
    const f = fixture(); f.game.users.activeGM = active;
    await f.discover(); assert.deepEqual(f.known(), []); assert.equal(f.itemResult.flags.skybricate.discovery, undefined);
    f.game.users.activeGM = f.game.user; f.handlers.get('updateUser')(); await f.service.settle(); assert.deepEqual(f.known(), ['p']);
  }
  const f = fixture(); f.game.user = { id: 'player', isGM: false };
  await f.discover(); assert.deepEqual(f.known(), []);
  f.game.user = f.game.users.activeGM; f.handlers.get('updateUser')(); await f.service.settle(); assert.deepEqual(f.known(), ['p']);
});

test('10 duplicate deliveries serialize once; queued writes use current data and activeGM', async () => {
  const f = fixture(); f.delivery(); f.delivery(); await f.service.settle(); assert.equal(f.counters.writes, 1);
  for (const mutate of [f => f.game.users.activeGM = null, f => f.sky.systems.s.components.a = []]) {
    const f = fixture(), promise = f.data.discoverCraftKnowledge(f.itemResult); mutate(f); await promise; assert.deepEqual(f.known(), []);
  }
  const g = fixture(); let release, entered;
  const gate = new Promise(resolve => release = resolve), waiting = new Promise(resolve => entered = resolve);
  const nativeUpdate = g.itemResult.update;
  g.itemResult.update = async function (patch) { await nativeUpdate.call(this, patch); entered(); await gate; };
  g.delivery(); await waiting;
  g.sky.systems.s.properties.p.name = 'New name'; g.sky.knowledge.other = { s: { c: ['p'] } }; g.sky.systems.s.components.c = ['p'];
  g.sky.systems.s.components.a = [];
  release(); await g.service.settle(); assert.deepEqual(g.known(), []);
  assert.deepEqual(g.sky.knowledge.other.s.c, ['p']); assert.equal(g.sky.systems.s.properties.p.name, 'New name');
});

test('10 discovery write errors are isolated, receipt prevents retries after failure, ready scan recovers new pending audit', async () => {
  const f = fixture(); f.game.settings.set = async () => { throw new Error('offline'); };
  await f.discover(); assert.deepEqual(f.known(), []); assert.equal(f.warnings.length, 1);
  await f.discover(); assert.equal(f.warnings.length, 1);
  const g = fixture(); const service = installCraftDiscovery({ hooks: { on() {} }, getGame: () => g.game, data: g.data });
  await service.settle(); assert.deepEqual(g.known(), ['p']);
});


test('turning transfer off preserves pending discovery earned by an earlier actual award', async () => {
  const f = fixture(); f.game.users.activeGM = null;
  await f.discover(); assert.deepEqual(f.known(), []);
  f.transfer = false;
  f.game.users.activeGM = f.game.user; f.handlers.get('updateUser')(); await f.service.settle();
  assert.deepEqual(f.known(), ['p']); assert.deepEqual(f.known('b'), ['p']);
  assert.equal(f.counters.writes, 1);
});
