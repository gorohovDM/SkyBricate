import { copy } from './data-model.js';

// State belongs to one result receiver, never the engine or an actor's methods.
const objectData = document => document?.toObject?.() ?? document;
const stable = value => JSON.stringify(value, (key, row) => row && typeof row === 'object' && !Array.isArray(row)
  ? Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]])) : row);
const overlaps = (a, b) => a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
function leaves(value, path = 'system', out = new Map()) {
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length) {
    for (const [key, child] of Object.entries(value)) leaves(child, `${path}.${key}`, out);
  } else out.set(path, stable(value));
  return out;
}
const effectKey = document => {
  const effect = objectData(document);
  const changes = effect?.changes?.some(change => typeof change.key === 'string' && !!change.key.trim() && Object.hasOwn(change, 'value'));
  const statuses = effect?.statuses?.some(status => typeof status === 'string' && !!status.trim());
  if (!effect || effect.disabled === true || !(changes || statuses)) return null;
  return stable({ changes: effect.changes ?? [], statuses: effect.statuses ?? [] });
};

// The plan is attribution only. Prove eligibility from the exact consumedItems
// handed to this result, including native failure-consumption policy.
export function consumedSelection(attempt, consumedItems) {
  const quantities = new Map();
  for (const { item, quantity } of consumedItems) {
    if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0) continue;
    quantities.set(item?.uuid, (quantities.get(item?.uuid) ?? 0) + quantity);
  }
  const planned = new Map();
  for (const row of attempt.composition) {
    const old = planned.get(row.itemUuid);
    if (old) { old.quantity += row.quantity; if (old.componentId !== row.componentId) old.componentId = null; }
    else planned.set(row.itemUuid, { ...row });
  }
  const actual = [...planned.values()].filter(row => {
    const quantity = quantities.get(row.itemUuid);
    return quantity > 0 && quantity <= row.quantity;
  }).map(row => ({ ...row, quantity: quantities.get(row.itemUuid) }));
  return attempt.selected.flatMap(property => {
    const sources = property.sources.filter(source => actual.some(row => row.componentId === source.componentId));
    if (sources.length < (property.selectionType === 'special' ? 1 : 2)) return [];
    return [{ ...property, sources: sources.map(source => ({ ...source,
      items: actual.filter(row => row.componentId === source.componentId).map(({ itemUuid, actorUuid, quantity, kind }) => ({ itemUuid, actorUuid, quantity, kind })) })) }];
  });
}

export function installResultApplication(scope, { system, sky, attempt, resolveUuid }) {
  const nativeSingle = scope._createSingleResult;
  const pending = [];
  if (typeof nativeSingle !== 'function') return async () => {}; // Capture-only engines do not award Items.
  scope._createSingleResult = async function (...args) {
    const [actor, result, consumedItems, , recipe] = args;
    const options = args[6] ?? {}, selected = consumedSelection(attempt(), consumedItems);
    const linkedIds = new Set(Object.values(sky.properties).map(property => property.essenceId).filter(Boolean));
    const nativeContext = this._buildEssenceContext(consumedItems, recipe, options.precomputedEssences, options.resolveComponent);
    // Independent stock essences keep quantities/library order, followed by Sky
    // properties in selection order, then the native result macro as last writer.
    const definitions = system.essenceDefinitions ?? [];
    const independent = definitions.filter(definition => !linkedIds.has(definition.id));
    const ordered = [...independent, ...selected.map(property => definitions.find(row => row.id === property.essenceId))];
    const resolved = Object.fromEntries(Object.entries(nativeContext.resolvedEssences).filter(([id]) => !linkedIds.has(id)));
    for (const property of selected) resolved[property.essenceId] = attempt().strength;
    const ids = [...Object.keys(nativeContext.resolvedEssences).filter(id => !linkedIds.has(id)), ...selected.map(property => property.essenceId)];
    // Object.keys on a plain record reorders integer-like IDs. A local view keeps
    // the same authored order for stock effect transfer without splitting batches.
    const orderedResolved = () => new Proxy({ ...resolved }, { ownKeys: () => ids });
    const enabled = Object.fromEntries(definitions.map(definition => [definition.id, definition.enabled !== false]));
    const receiver = Object.create(this), writes = new Map(), createdEffects = new Map();
    const nativeBuild = this._buildEssenceContext, nativeSource = this._sourceUuidForEssenceDefinition;
    receiver._buildEssenceContext = function (items, nativeRecipe, precomputed, resolver) {
      if (precomputed !== resolved) return nativeBuild.call(this, items, nativeRecipe, precomputed, resolver);
      return { resolvedEssences: orderedResolved(), essenceSources: Object.fromEntries(Object.entries(nativeContext.essenceSources)
        .filter(([id]) => !linkedIds.has(id))) };
    };
    receiver._sourceUuidForEssenceDefinition = function (definition) {
      return nativeSource.call(this, definitions.find(row => row.id === definition?.id), system);
    };
    let baseline = null;
    const nativeEssenceMacros = this._runEssencePropertyMacros, nativeApply = this._applyEssencePropertyUpdates;
    const nativeResultMacro = this._runPropertyMacro, nativeEffects = this._transferEffects;
    function invalidate(paths) {
      for (const path of writes.keys()) if (paths.some(next => overlaps(path, next))) writes.delete(path);
    }
    receiver._runEssencePropertyMacros = async function (itemData, context) {
      // Registered source Items can themselves be prior crafted outputs. Their
      // historical audit is never evidence about this new award.
      if (itemData.flags?.skybricate) delete itemData.flags.skybricate.application;
      baseline = leaves(copy(itemData.system));
      const applied = await nativeEssenceMacros.call(this, itemData, { ...context,
        system: { ...system, essenceDefinitions: ordered }, precomputedEssences: resolved, essenceEnabled: enabled });
      // Native stacking discards itemData. Eligible Sky outputs need their own
      // audit even with a no-op macro. Empty selections keep native stacking.
      return applied || selected.length > 0;
    };
    receiver._applyEssencePropertyUpdates = function (itemData, updates, definition) {
      const before = leaves(copy(itemData.system));
      // Invalidate identical later writes too; on partial errors invalidate all
      // declared paths conservatively rather than guessing a writer's intent.
      invalidate(Object.keys(updates));
      const applied = nativeApply.call(this, itemData, updates, definition);
      const after = leaves(copy(itemData.system));
      if (selected.some(property => property.essenceId === definition.id)) {
        for (const path of after.keys()) {
          if (before.get(path) !== after.get(path)) writes.set(path, { essenceId: definition.id, value: after.get(path) });
        }
      }
      return applied;
    };
    receiver._runPropertyMacro = async function (...macroArgs) {
      const updates = await nativeResultMacro.apply(this, macroArgs);
      if (updates && typeof updates === 'object') invalidate(Object.keys(updates));
      return updates;
    };
    receiver._transferEffects = async function (item, consumed, nativeRecipe, ignored, resolver) {
      if (!selected.length) return nativeEffects.call(this, item, consumed, nativeRecipe, resolved, resolver, enabled);
      // Observe source templates for conservative attribution; native still resolves
      // and creates its entire batch once. If templates changed between reads, no
      // ownership is inferred. Native source/creation exceptions retain stock order.
      const expected = [];
      if (system.features?.essences) for (const essenceId of ids) {
        if (!enabled[essenceId]) continue;
        const definition = definitions.find(row => row.id === essenceId);
        const uuid = this._sourceUuidForEssenceDefinition(definition, system);
        if (!uuid) continue;
        const source = await resolveUuid(uuid);
        for (const effect of source?.effects ?? []) expected.push({ essenceId, data: effect.toObject() });
      }
      const observed = { createEmbeddedDocuments: async (...effectArgs) => {
        const documents = await item.createEmbeddedDocuments(...effectArgs);
        const payload = effectArgs[1];
        if (stable(payload) === stable(expected.map(row => row.data))) {
          const owners = new Map();
          for (const row of expected) {
            const key = effectKey(row.data);
            if (key) owners.set(key, owners.has(key) ? null : row.essenceId);
          }
          for (const document of documents ?? []) {
            const owner = owners.get(effectKey(document));
            if (owner && (document.id ?? document._id)) createdEffects.set(document.id ?? document._id, owner);
          }
        }
        return documents;
      } };
      await nativeEffects.call(this, observed, consumed, nativeRecipe, resolved, resolver, enabled);
    };
    args[6] = { ...options, precomputedEssences: resolved, essenceEnabled: enabled };
    // Native exceptions propagate: no audit is written for an unreturned award.
    const item = await nativeSingle.apply(receiver, args);
    if (!item || !selected.length) return item;
    pending.push({ item, finalize: async nativeResult => {
      if (!Array.from(actor.items ?? []).some(document => document === item || (item.uuid && document.uuid === item.uuid))) return;
      const final = leaves(objectData(item).system), macroIds = new Set();
      for (const [path, write] of writes) {
        if (final.get(path) === write.value && baseline?.get(path) !== write.value) macroIds.add(write.essenceId);
      }
      const effects = Array.from(item.effects ?? []), counts = new Map(), effectIds = new Set();
      for (const effect of effects) { const key = effectKey(effect); if (key) counts.set(key, (counts.get(key) ?? 0) + 1); }
      for (const effect of effects) {
        const key = effectKey(effect), owner = createdEffects.get(effect.id ?? effect._id);
        if (key && counts.get(key) === 1 && owner) effectIds.add(owner);
      }
      const context = attempt();
      const applied = selected.filter(property => macroIds.has(property.essenceId) || effectIds.has(property.essenceId)).map(property => ({
        propertyId: property.propertyId, essenceId: property.essenceId, selectionType: property.selectionType,
        sources: property.sources, outcomeId: context.outcomeId, strength: context.strength,
        macro: macroIds.has(property.essenceId), effects: effectIds.has(property.essenceId)
      }));
      const audit = { version: 1, craftingSystemId: context.craftingSystemId, recipeId: context.recipeId,
        resultId: result.id ?? null, actorUuid: actor.uuid, checkSuccess: context.checkResult.success === true,
        craftSuccess: nativeResult.success === true,
        outcomeId: context.outcomeId, strength: context.strength, applied };
      // Only actual issued data/effects count; IDs/provenance contain no hidden names.
      await item.update({ 'flags.skybricate.application': audit });
    } });
    return item;
  };
  // Delay audit until the complete native call returns its issued result list.
  // A later result/chat exception or a swallowed failure-award exception must
  // not leave a completed audit on an earlier, partially produced output.
  return async result => {
    for (const row of pending) if (result?.results?.includes(row.item)) await row.finalize(result);
  };
}
