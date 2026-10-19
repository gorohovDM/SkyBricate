import { assertKey } from './data-model.js';

export const FABRICATE_SYSTEMS_SETTING = 'fabricate.craftingSystems';

function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Invalid persisted record');
}

// Fabricate 1.9.10's SettingsCraftingDefinitionRepository writes the FULL array
// to this world setting. Never substitute manager summaries, UI stores or drafts.
export function persistedSystems(game) {
  const module = game.modules?.get('fabricate');
  const setting = game.settings?.settings?.get(FABRICATE_SYSTEMS_SETTING);
  if (!module?.active || module.version !== '1.9.10' || setting?.scope !== 'world' || setting.type !== Array) {
    throw new Error('Unsupported persisted Fabricate contract');
  }
  const stored = game.settings.get('fabricate', 'craftingSystems');
  if (!Array.isArray(stored)) throw new Error('Incomplete persisted system corpus');
  const systems = new Map();
  for (const system of stored) {
    record(system); assertKey(system.id);
    if (systems.has(system.id) || !Array.isArray(system.components)) throw new Error('Invalid persisted system');
    const components = new Map();
    for (const component of system.components) {
      record(component); assertKey(component.id);
      if (components.has(component.id)) throw new Error('Duplicate component ID');
      if (component.name !== undefined && typeof component.name !== 'string') throw new Error('Invalid component name');
      components.set(component.id, { id: component.id, name: component.name ?? '' });
    }
    if (system.name !== undefined && typeof system.name !== 'string') throw new Error('Invalid system name');
    systems.set(system.id, { id: system.id, name: system.name ?? '', components });
  }
  return systems;
}

export function persistedComponents(game, systemId) {
  assertKey(systemId);
  const system = persistedSystems(game).get(systemId);
  if (!system) throw new Error('Unknown persisted system');
  return new Set(system.components.keys());
}
