import { assertKey, copy } from './data-model.js';

export const isActiveGM = game => game.user?.isGM === true && !!game.user.id
  && game.users?.activeGM?.id === game.user.id;

// Read only persisted, live embedded Items. Hook arguments are notifications,
// never a source of knowledge or an authorization to write another Actor.
export function discoveryContext(game, item) {
  const actor = item?.parent, audit = item?.flags?.skybricate?.application;
  if (!actor?.id || game.actors?.get(actor.id) !== actor
    || !Array.from(actor.items ?? []).includes(item) || !item.uuid
    || audit?.version !== 1 || audit.discoveryVersion !== 1 || audit.itemUuid !== item.uuid
    || audit.actorUuid !== actor.uuid || audit.craftSuccess !== true
    || !Array.isArray(audit.applied)) return null;
  [actor.id, audit.craftingSystemId, audit.recipeId].forEach(assertKey);
  return { actorId: actor.id, audit: copy(audit) };
}

export function discoverySources(audit, system, present) {
  const pairs = new Map();
  for (const property of audit.applied) {
    assertKey(property.propertyId); assertKey(property.essenceId);
    if (!(property.macro === true || property.effects === true)
      || system?.properties[property.propertyId]?.essenceId !== property.essenceId
      || !['special', 'matched'].includes(property.selectionType) || !Array.isArray(property.sources)) continue;
    const sources = property.sources.filter(source => {
      assertKey(source.componentId);
      const collection = source.assignmentType === 'special' ? system.specialComponents
        : source.assignmentType === 'ordinary' ? system.components : null;
      return present.has(source.componentId) && collection?.[source.componentId]?.includes(property.propertyId)
        && (property.selectionType !== 'special' || source.assignmentType === 'special')
        && Array.isArray(source.items) && source.items.length > 0
        && source.items.every(row => typeof row.itemUuid === 'string' && !!row.itemUuid
          && Number.isFinite(row.quantity) && row.quantity > 0 && ['ingredient', 'extra'].includes(row.kind));
    });
    if (new Set(sources.map(source => source.componentId)).size < (property.selectionType === 'special' ? 1 : 2)) continue;
    for (const source of sources) pairs.set(JSON.stringify([source.componentId, property.propertyId]), [source.componentId, property.propertyId]);
  }
  return [...pairs.values()];
}

export function installCraftDiscovery({ hooks, getGame, data, logger = console }) {
  const pending = new Set();
  const discover = item => {
    if (!isActiveGM(getGame())) return Promise.resolve();
    const task = data.discoverCraftKnowledge(item).catch(() => {
      logger.warn('SkyBricate | Automatic knowledge discovery failed; GM may reveal knowledge manually.');
    });
    pending.add(task); task.finally(() => pending.delete(task));
    return task;
  };
  const scan = () => {
    if (isActiveGM(getGame())) for (const actor of getGame().actors ?? []) for (const item of actor.items ?? []) {
      if (item.flags?.skybricate?.application?.discoveryVersion === 1 && !item.flags?.skybricate?.discovery) discover(item);
    }
  };
  const update = (item, change) => {
    if (Object.hasOwn(change ?? {}, 'flags.skybricate.application') || change?.flags?.skybricate?.application) return discover(item);
  };
  hooks.on('updateItem', update);
  hooks.on('updateUser', scan);
  scan();
  return { settle: async () => { while (pending.size) await Promise.all([...pending]); } };
}
