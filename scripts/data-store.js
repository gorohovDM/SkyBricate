import { assertKey, assertFields, copy, emptyData, emptySystem, requireProperty, readData, validateData, validateLegacyData, pruneKnowledge, validateRecipeRules } from "./data-model.js";
import { persistedComponents, persistedSystems } from './assignment-contract.js';
import { persistedRecipes, recipeContext, validateOutcomeLimits } from './recipe-contract.js';
import { systemEssences } from './craft-adapter.js';
import { discoveryContext, discoverySources, isActiveGM } from './craft-discovery.js';

export const SETTING_NAMESPACE = "skybricate";
export const SETTING_KEY = "data";
export const SPECIAL_SETTING_KEY = "showSpecialProperties";
export const specialPropertiesEnabled = game => game.settings.get(SETTING_NAMESPACE, SPECIAL_SETTING_KEY) === true;
const specialSettingListeners = new Set();
let specialSettingRevision = 0;
const dataListeners = new Set();
export function subscribeData(listener) {
  dataListeners.add(listener);
  return () => dataListeners.delete(listener);
}
export function subscribeSpecialSetting(listener) {
  specialSettingListeners.add(listener);
  return () => specialSettingListeners.delete(listener);
}

export function registerDataSetting(settings) {
  settings.register(SETTING_NAMESPACE, SPECIAL_SETTING_KEY, {
    name: "SKYBRICATE.Editor.SpecialSetting", hint: "SKYBRICATE.Editor.SpecialSettingHint",
    scope: "world", config: true, type: Boolean, default: false,
    onChange: () => { specialSettingRevision++; for (const listener of specialSettingListeners) listener(); }
  });
  settings.register(SETTING_NAMESPACE, SETTING_KEY, {
    scope: "world", config: false, type: Object, default: emptyData(),
    onChange: () => { for (const listener of dataListeners) listener(); }
  });
}

// Internal service; each client serializes its writes, while cross-client writes
// retain Foundry's last-write-wins behavior. No mutable snapshot is cached.
export class DataStore {
  #getGame;
  #idFactory;
  #tail = Promise.resolve();

  constructor({ getGame, idFactory = () => globalThis.crypto.randomUUID() }) {
    this.#getGame = getGame;
    this.#idFactory = idFactory;
  }

  getSnapshot() {
    const stored = this.#getGame().settings.get(SETTING_NAMESPACE, SETTING_KEY);
    const data = stored === undefined ? emptyData() : stored;
    return readData(data);
  }

  getEssences(systemId) { return systemEssences(this.#getGame(), systemId); }
  getComponentIds(systemId) { return persistedComponents(this.#getGame(), systemId); }

  #enqueue(operation) {
    const queued = this.#tail.then(() => {
      const game = this.#getGame();
      if (!game.user?.isGM) throw new Error("SkyBricate writes require a GM");
      return operation(game);
    });
    this.#tail = queued.catch(() => {});
    return queued;
  }

  #write(change) {
    return this.#enqueue(async game => {
      const data = this.getSnapshot();
      const result = change(data);
      pruneKnowledge(data);
      validateData(data);
      await game.settings.set(SETTING_NAMESPACE, SETTING_KEY, copy(data));
      return copy(result);
    });
  }

  setPropertyKnowledge(actorId, systemId, componentId, propertyId, known, { canWrite = () => true } = {}) {
    return this.#write(data => {
      [actorId, systemId, componentId, propertyId].forEach(assertKey);
      if (typeof known !== 'boolean') throw new Error('Knowledge must be boolean');
      const game = this.#getGame();
      if (!canWrite() || !game.actors?.get(actorId)
        || !persistedComponents(game, systemId).has(componentId)) throw new Error('Knowledge context is no longer available');
      const system = data.systems[systemId];
      requireProperty(system, propertyId);
      if (![...(system.components[componentId] ?? []), ...(system.specialComponents[componentId] ?? [])].includes(propertyId)) {
        throw new Error('Knowledge requires an assignment');
      }
      const systems = data.knowledge[actorId] ??= {};
      const components = systems[systemId] ??= {};
      const ids = components[componentId] ??= [];
      if (known && !ids.includes(propertyId)) ids.push(propertyId);
      if (!known) components[componentId] = ids.filter(id => id !== propertyId);
    });
  }

  discoverCraftKnowledge(item) {
    return this.#enqueue(async game => {
      if (!isActiveGM(game) || item?.flags?.skybricate?.discovery) return;
      const context = discoveryContext(game, item);
      if (!context) return;
      const { actorId, audit } = context;
      const data = this.getSnapshot();
      const sources = discoverySources(audit, data.systems[audit.craftingSystemId], persistedComponents(game, audit.craftingSystemId));
      // Claim once, before the world write. An interrupted/failed write is left
      // for manual GM recovery, never replayed after a GM deliberately hides it.
      await item.update({ 'flags.skybricate.discovery': { version: 1 } });
      if (!isActiveGM(game)) return;
      const latest = discoveryContext(game, item);
      if (!latest || JSON.stringify(latest.audit) !== JSON.stringify(audit)) return;
      // An Item update can await network I/O. Read settings and assignments again
      // afterwards so another GM's edits are not replaced by an old snapshot.
      const current = this.getSnapshot();
      const allowed = new Set(sources.map(pair => JSON.stringify(pair)));
      const live = discoverySources(audit, current.systems[audit.craftingSystemId], persistedComponents(game, audit.craftingSystemId))
        .filter(pair => allowed.has(JSON.stringify(pair)));
      if (!live.length) return;
      for (const [componentId, propertyId] of live) {
        const components = (current.knowledge[actorId] ??= {})[audit.craftingSystemId] ??= {};
        const ids = components[componentId] ??= [];
        if (!ids.includes(propertyId)) ids.push(propertyId);
      }
      pruneKnowledge(current); validateData(current);
      await game.settings.set(SETTING_NAMESPACE, SETTING_KEY, copy(current));
    });
  }

  hasLegacyData() {
    try {
      validateLegacyData(this.#getGame().settings.get(SETTING_NAMESPACE, SETTING_KEY));
      return true;
    } catch { return false; }
  }

  resetLegacyData() {
    return this.#enqueue(async game => {
      // Check again when dequeued: never overwrite a newer schema or corrupt data.
      validateLegacyData(game.settings.get(SETTING_NAMESPACE, SETTING_KEY));
      await game.settings.set(SETTING_NAMESPACE, SETTING_KEY, emptyData());
    });
  }

  createProperty(systemId, input) {
    const values = copy(input);
    return this.#write(data => {
      assertFields(values, ["name", "description", "essenceId"]);
      this.#validateEssenceLink(systemId, values.essenceId);
      const system = this.#system(data, systemId);
      const id = assertKey(this.#idFactory());
      if (Object.hasOwn(system.properties, id)) throw new Error("Property ID collision");
      system.properties[id] = { name: values.name, description: Object.hasOwn(values, "description") ? values.description : "" };
      if (values.essenceId) system.properties[id].essenceId = values.essenceId;
      return id;
    });
  }

  updateProperty(systemId, id, patch) {
    const values = copy(patch);
    return this.#write(data => {
      assertKey(systemId);
      const system = data.systems[systemId];
      requireProperty(system, id);
      assertFields(values, ["name", "description", "essenceId"]);
      if (Object.hasOwn(values, 'essenceId')) this.#validateEssenceLink(systemId, values.essenceId);
      Object.assign(system.properties[id], values);
      if (values.essenceId === null) delete system.properties[id].essenceId;
    });
  }

  #validateEssenceLink(systemId, essenceId) {
    if (essenceId === undefined || essenceId === null) return;
    assertKey(essenceId);
    if (!this.getEssences(systemId).some(row => row.id === essenceId)) {
      throw new Error('Choose an essence of the current Fabricate system');
    }
  }

  deleteProperty(systemId, id) {
    return this.#write(data => {
      assertKey(systemId);
      const system = data.systems[systemId];
      requireProperty(system, id);
      delete system.properties[id];
      for (const assignments of [system.categories, system.components, system.specialComponents]) {
        for (const key of Object.keys(assignments)) assignments[key] = assignments[key].filter(value => value !== id);
      }
      system.rules.propertyOrder = system.rules.propertyOrder.filter(value => value !== id);
      for (const rules of Object.values(system.recipeRules)) {
        rules.allowedPropertyIds = rules.allowedPropertyIds.filter(value => value !== id);
        rules.propertyOrder = rules.propertyOrder.filter(value => value !== id);
      }
    });
  }

  #system(data, systemId) {
    assertKey(systemId);
    if (!Object.hasOwn(data.systems, systemId)) data.systems[systemId] = emptySystem();
    return data.systems[systemId];
  }

  ensureSystem(systemId) {
    return this.#write(data => { this.#system(data, systemId); });
  }

  #assign(systemId, collection, key, propertyIds) {
    const ids = copy(propertyIds);
    return this.#write(data => {
      assertKey(key);
      this.#system(data, systemId)[collection][key] = ids;
    });
  }

  setCategoryProperties(systemId, categoryKey, propertyIds) {
    return this.#assign(systemId, "categories", categoryKey, propertyIds);
  }

  setComponentProperties(systemId, componentId, propertyIds, options = {}) {
    return this.setComponentAssignments(systemId, componentId, { ordinary: propertyIds }, options);
  }

  setComponentAssignments(systemId, componentId, input, { canWrite = () => true, editSpecial = false } = {}) {
    const values = copy(input);
    const settingRevision = specialSettingRevision;
    const specialEditable = editSpecial && specialPropertiesEnabled(this.#getGame());
    return this.#write(data => {
      assertFields(values, ["ordinary", "special"]);
      if (!Object.hasOwn(values, "ordinary")) throw new Error("Missing ordinary assignments");
      assertKey(componentId);
      if (!canWrite() || !persistedComponents(this.#getGame(), systemId).has(componentId)) {
        throw new Error('Component context is no longer available');
      }
      const system = this.#system(data, systemId);
      if (Object.hasOwn(values, "special")) {
        if (!Array.isArray(values.special)) throw new Error("Property references must be an array");
        values.special.forEach(id => requireProperty(system, id));
        if (new Set(values.special).size !== values.special.length) throw new Error("Duplicate property reference");
      }
      system.components[componentId] = values.ordinary;
      // Hidden assignments come from the latest queued snapshot. A window
      // opened while hidden cannot clear them after the setting becomes enabled.
      if (specialEditable && settingRevision === specialSettingRevision && specialPropertiesEnabled(this.#getGame())) {
        if (!Object.hasOwn(values, "special")) throw new Error("Missing special assignments");
        system.specialComponents[componentId] = values.special;
      }
    });
  }

  reconcileComponentProperties(systemId, componentIds = null, { canWrite = () => true } = {}) {
    const requested = componentIds === null ? null : copy(componentIds);
    return this.#write(data => {
      if (!canWrite()) throw new Error('Component context is no longer available');
      const present = persistedComponents(this.#getGame(), systemId);
      if (requested !== null) {
        if (!Array.isArray(requested)) throw new Error('Invalid deleted IDs');
        requested.forEach(assertKey);
      }
      for (const assignments of [data.systems[systemId]?.components, data.systems[systemId]?.specialComponents]) {
        for (const id of requested ?? Object.keys(assignments ?? {})) {
          if (assignments && !present.has(id)) delete assignments[id];
        }
      }
    });
  }

  reconcileAllComponentProperties({ canWrite = () => true } = {}) {
    return this.#write(data => {
      if (!canWrite()) throw new Error('Component context is no longer available');
      const systems = persistedSystems(this.#getGame());
      // The validated full corpus is authoritative for knowledge contexts.
      // Preserve old catalogs/assignments for absent systems, as before.
      for (const knownSystems of Object.values(data.knowledge)) {
        for (const systemId of Object.keys(knownSystems)) if (!systems.has(systemId)) delete knownSystems[systemId];
      }
      for (const [id, system] of systems) {
        for (const assignments of [data.systems[id]?.components, data.systems[id]?.specialComponents]) {
          for (const componentId of Object.keys(assignments ?? {})) {
            if (!system.components.has(componentId)) delete assignments[componentId];
          }
        }
      }
      // An absent system is not evidence of a complete empty component list.
    });
  }

  renameCategory(systemId, oldKey, newKey) {
    return this.#write(data => {
      assertKey(systemId); assertKey(oldKey); assertKey(newKey);
      const categories = data.systems[systemId]?.categories;
      if (!categories || !Object.hasOwn(categories, oldKey)) throw new Error("Unknown category");
      if (oldKey === newKey) return;
      if (Object.hasOwn(categories, newKey)) throw new Error("Category rename conflict");
      categories[newKey] = categories[oldKey];
      delete categories[oldKey];
    });
  }

  #remove(systemId, collection, key) {
    return this.#write(data => {
      assertKey(systemId); assertKey(key);
      if (Object.hasOwn(data.systems, systemId)) delete data.systems[systemId][collection][key];
    });
  }

  deleteCategory(systemId, categoryKey) { return this.#remove(systemId, "categories", categoryKey); }
  deleteComponent(systemId, componentId) {
    return this.#write(data => {
      assertKey(systemId); assertKey(componentId);
      if (Object.hasOwn(data.systems, systemId)) {
        delete data.systems[systemId].components[componentId];
        delete data.systems[systemId].specialComponents[componentId];
      }
    });
  }

  configureRules(systemId, patch) {
    const values = copy(patch);
    return this.#write(data => {
      const rules = this.#system(data, systemId).rules;
      assertFields(values, Object.keys(rules));
      Object.assign(rules, values);
    });
  }

  configureRecipeRules(systemId, recipeId, input, { canWrite = () => true, expectedRules, expectedContext } = {}) {
    const values = copy(input), expected = copy(expectedRules);
    return this.#write(data => {
      if (!canWrite()) throw new Error('Recipe context is no longer available');
      const context = recipeContext(this.#getGame(), systemId, recipeId);
      if (expectedContext !== undefined && context.revision !== expectedContext) throw new Error('Recipe changed; reload its rules');
      const system = this.#system(data, systemId);
      if (expectedRules !== undefined && JSON.stringify(system.recipeRules[recipeId] ?? null) !== JSON.stringify(expected)) {
        throw new Error('Recipe rules changed; reload before saving');
      }
      validateRecipeRules(system, values);
      validateOutcomeLimits(values, context.outcomes);
      system.recipeRules[recipeId] = values;
    });
  }

  reconcileRecipeRules({ canWrite = () => true } = {}) {
    return this.#write(data => {
      if (!canWrite()) throw new Error('Recipe context is no longer available');
      const recipes = persistedRecipes(this.#getGame());
      for (const [systemId, system] of Object.entries(data.systems)) {
        for (const id of Object.keys(system.recipeRules)) {
          if (recipes.get(id)?.craftingSystemId !== systemId) delete system.recipeRules[id];
        }
      }
    });
  }

  deleteSystem(systemId) {
    return this.#write(data => { assertKey(systemId); delete data.systems[systemId]; });
  }
}
