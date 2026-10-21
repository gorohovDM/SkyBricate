import { copy } from './data-model.js';

// Corruption/staleness detector, not an authorization signature. Persist hashes,
// IDs and quantities only: no property names or descriptions enter native runs.
export function fingerprint(value) {
  const text = JSON.stringify(value, (key, row) => row && typeof row === 'object' && !Array.isArray(row)
    ? Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]])) : row) ?? 'undefined';
  let hash = 2166136261;
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `${text.length}:${hash >>> 0}`;
}

export function runRevision(system, sky, recipe) {
  const definition = copy(system);
  // Stock snapshots essence enabled-ness at START. A live toggle is allowed;
  // the saved complete gate map is used for Sky and independent native essences.
  for (const essence of definition.essenceDefinitions ?? []) delete essence.enabled;
  if (definition.requirements?.time) delete definition.requirements.time.enabled;
  return fingerprint([definition, sky, recipe.toJSON?.() ?? recipe]);
}

export function runBinding(actor, recipe, revision, run) {
  return { version: 1, actorUuid: actor.uuid, recipeId: recipe.id,
    craftingSystemId: recipe.craftingSystemId, runId: run.id, revision };
}

export function validateRun(run, binding, system) {
  if (fingerprint(run.skybricate) !== fingerprint(binding) || run.actorUuid !== binding.actorUuid
    || run.recipeId !== binding.recipeId || run.craftingSystemId !== binding.craftingSystemId) throw new Error('Missing or stale SkyBricate run context');
  const index = run.currentStepIndex;
  if (!['inProgress', 'waitingTime'].includes(run.status) || !Number.isInteger(index) || index < 0 || !run.steps?.[index]
    || run.steps.slice(0, index).some(step => step.status !== 'succeeded')) throw new Error('Invalid active step');
  const step = run.steps[index], state = step.skybricate;
  if (!['inProgress', 'waitingTime'].includes(step.status)) throw new Error('Invalid active step status');
  if (!step.preparedConsumption) {
    // A failed interrupted START must never spend the same inputs again.
    if (state) throw new Error('Interrupted SkyBricate consumption');
    if (step.timeGate && !step.timeGate.collapsedChain) throw new Error('Legacy timed run has no provenance');
    return null;
  }
  if (!state || state.stepId !== step.stepId || state.index !== index || !Array.isArray(state.composition)
    || state.digest !== fingerprint([state.composition, state.essenceEnabled])
    || state.prepared !== fingerprint(step.preparedConsumption)) throw new Error('Corrupt prepared provenance');
  for (const row of state.composition) {
    if (typeof row.itemUuid !== 'string' || !row.itemUuid || !(row.actorUuid === null || typeof row.actorUuid === 'string')
      || !Number.isFinite(row.quantity) || row.quantity <= 0 || row.kind !== 'ingredient'
      || !(row.componentId === null || system.components.some(component => component.id === row.componentId))) {
      throw new Error('Invalid prepared composition');
    }
  }
  const totals = rows => {
    const map = new Map();
    for (const row of rows) map.set(row.itemUuid, (map.get(row.itemUuid) ?? 0) + row.quantity);
    return [...map].sort(([a], [b]) => a.localeCompare(b));
  };
  if (fingerprint(totals(state.composition)) !== fingerprint(totals(step.preparedConsumption.consumedSummary))) {
    throw new Error('Prepared consumption does not match provenance');
  }
  const definitions = system.essenceDefinitions ?? [];
  if (!state.essenceEnabled || Object.keys(state.essenceEnabled).length !== definitions.length
    || definitions.some(row => typeof state.essenceEnabled[row.id] !== 'boolean')) throw new Error('Invalid prepared gates');
  return copy(state);
}
