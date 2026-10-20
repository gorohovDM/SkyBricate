import test from 'node:test';
import assert from 'node:assert/strict';
import { selectProperties } from '../scripts/property-selection.js';
import { emptySystem } from '../scripts/data-model.js';

function fixture() {
  const system = emptySystem();
  for (const id of ['X', 'Y', 'Z', 'a', 'b']) system.properties[id] = { name: id, description: '' };
  system.components = { A: ['Y', 'Z'], B: ['X', 'Y', 'Z'], C: ['X'] };
  system.specialComponents = { A: ['X'], B: ['b', 'a'] };
  return { system, componentIds: ['C', 'B', 'A'] };
}
const ids = result => result.map(item => item.propertyId);

test('selection: matching counts different components and combines both assignment types by default', () => {
  const f = fixture();
  assert.deepEqual(ids(selectProperties(f)), ['X', 'Y', 'Z']);
  assert.deepEqual(selectProperties(f)[0], { propertyId: 'X', selectionType: 'matched', sources: [
    { componentId: 'A', assignmentType: 'special' }, { componentId: 'B', assignmentType: 'ordinary' },
    { componentId: 'C', assignmentType: 'ordinary' }
  ] });
  assert.deepEqual(selectProperties({ ...f, componentIds: ['A', 'A', 'A'] }), []);
  assert.deepEqual(selectProperties({ ...f, componentIds: [] }), []);
  assert.deepEqual(selectProperties({ ...f, componentIds: ['unassigned'] }), []);
});

test('selection: special priority, group order and exclusive special provenance', () => {
  const f = fixture();
  f.recipeRules = { prioritySpecial: true, propertyOrder: ['Z', 'b', 'X', 'Y'] };
  const result = selectProperties(f);
  assert.deepEqual(ids(result), ['b', 'X', 'a', 'Z', 'Y']);
  assert.deepEqual(result[1], { propertyId: 'X', selectionType: 'special', sources: [
    { componentId: 'A', assignmentType: 'special' }
  ] });
  f.recipeRules = { ...f.recipeRules, limitByCheck: true, outcomeLimits: { pass: 1 } };
  assert.deepEqual(ids(selectProperties({ ...f, outcome: 'pass' })), ['b']);
});

test('selection: a shared limit counts distinct property IDs, with zero and unlimited supported', () => {
  const f = fixture();
  f.recipeRules = { propertyOrder: ['Z'], limitByCheck: true, outcomeLimits: { fail: 0, pass: 2, great: 20 } };
  assert.deepEqual(selectProperties({ ...f, outcome: 'fail' }), []);
  assert.deepEqual(ids(selectProperties({ ...f, outcome: 'pass' })), ['Z', 'X']);
  assert.deepEqual(ids(selectProperties({ ...f, outcome: 'great' })), ['Z', 'X', 'Y']);
  f.recipeRules.limitByCheck = false;
  assert.deepEqual(ids(selectProperties(f)), ['Z', 'X', 'Y']);
});

test('selection: missing and unknown limited outcomes throw even with no components', () => {
  const f = { ...fixture(), componentIds: [], recipeRules: { limitByCheck: true, outcomeLimits: { pass: 0 } } };
  for (const outcome of [undefined, null, '', 'unknown', 'constructor', '__proto__']) {
    assert.throws(() => selectProperties({ ...f, outcome }));
  }
  assert.deepEqual(selectProperties({ ...f, outcome: 'pass' }), []);
});

test('selection: immutable inputs and deterministic order regardless of component and assignment order', () => {
  const f = fixture();
  const before = structuredClone(f);
  const result = selectProperties(f);
  assert.deepEqual(f, before);
  f.componentIds.reverse(); f.componentIds.push('A'); f.system.components.B.reverse();
  assert.deepEqual(selectProperties(f), result);
  result[0].sources[0].componentId = 'changed';
  assert.deepEqual(selectProperties(f)[0].sources[0].componentId, 'A');
});

test('selection: system rules, category assignments, knowledge and display toggles do not affect recipe selection', () => {
  const f = fixture(), expected = selectProperties(f);
  f.system.rules = { limitByCheck: true, outcomeLimits: { pass: 0 }, prioritySpecial: true, propertyOrder: ['Z'] };
  f.system.categories = { category: ['a', 'b'] };
  f.system.knowledge = { A: ['X'] }; f.system.showSpecialProperties = false;
  assert.deepEqual(selectProperties(f), expected);
  f.system.showSpecialProperties = true;
  assert.deepEqual(selectProperties(f), expected);
});

test('selection: rejects malformed records, IDs, duplicate references and invalid assignment types', () => {
  const mutations = [
    f => { f.componentIds = 'A'; }, f => { f.componentIds = [null]; },
    f => { f.componentIds = ['__proto__']; }, f => { f.system.components = []; },
    f => { f.system.properties = null; }, f => { f.system.specialComponents = new Date(); },
    f => { f.system.components.A = ['missing']; }, f => { f.system.components.A = ['Y', 'Y']; },
    f => { f.system.specialComponents.A = ['Y']; },
    f => { f.system.components = JSON.parse('{"__proto__":[]}'); },
    f => { f.recipeRules = { propertyOrder: ['missing'] }; },
    f => { f.recipeRules = { propertyOrder: ['Y', 'Y'] }; },
    f => { f.recipeRules = { prioritySpecial: 1 }; }, f => { f.recipeRules = { limitByCheck: null }; },
    f => { f.recipeRules = { successLimit: 1 }; }, f => { f.recipeRules = null; },
    f => { f.recipeRules = { outcomeLimits: [] }; },
    ...[-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '2'].map(count => f => {
      f.recipeRules = { outcomeLimits: { pass: count } };
    })
  ];
  for (const mutate of mutations) { const f = fixture(); mutate(f); assert.throws(() => selectProperties(f)); }
});
