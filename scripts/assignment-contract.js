import { assertKey } from './data-model.js';

export const ASSIGNMENT_CONTRACT = 'fabricate-component-assignments-v1';
export const DELETED_HOOK = 'fabricate.componentsDeleted';

export function getAssignmentContract(game) {
  const contract = game.fabricate?.getCraftingSystemManager?.()?.componentAssignmentContract;
  if (contract?.version !== ASSIGNMENT_CONTRACT || contract.deletedHook !== DELETED_HOOK
    || typeof contract.readPersistedSystem !== 'function') throw new Error('AssignmentContract');
  return contract;
}

// Only the full persisted snapshot is evidence of absence. No UI/store projection.
export function persistedComponents(game, systemId) {
  assertKey(systemId);
  const snapshot = getAssignmentContract(game).readPersistedSystem(systemId);
  if (snapshot?.systemId !== systemId || snapshot.complete !== true || !Array.isArray(snapshot.componentIds)) {
    throw new Error('Incomplete persisted component snapshot');
  }
  snapshot.componentIds.forEach(assertKey);
  if (new Set(snapshot.componentIds).size !== snapshot.componentIds.length) throw new Error('Duplicate component ID');
  return new Set(snapshot.componentIds);
}
