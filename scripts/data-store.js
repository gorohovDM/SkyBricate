import { assertKey, assertFields, copy, emptyData, emptySystem, requireProperty, validateData, validateLegacyData } from "./data-model.js";
import { persistedComponents } from './assignment-contract.js';

export const SETTING_NAMESPACE = "skybricate";
export const SETTING_KEY = "data";

export function registerDataSetting(settings) {
  settings.register(SETTING_NAMESPACE, SETTING_KEY, {
    scope: "world", config: false, type: Object, default: emptyData()
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
    validateData(data);
    return copy(data);
  }

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
      validateData(data);
      await game.settings.set(SETTING_NAMESPACE, SETTING_KEY, copy(data));
      return copy(result);
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
      assertFields(values, ["name", "description"]);
      const system = this.#system(data, systemId);
      const id = assertKey(this.#idFactory());
      if (Object.hasOwn(system.properties, id)) throw new Error("Property ID collision");
      system.properties[id] = { name: values.name, description: Object.hasOwn(values, "description") ? values.description : "" };
      return id;
    });
  }

  updateProperty(systemId, id, patch) {
    const values = copy(patch);
    return this.#write(data => {
      assertKey(systemId);
      const system = data.systems[systemId];
      requireProperty(system, id);
      assertFields(values, ["name", "description"]);
      Object.assign(system.properties[id], values);
    });
  }

  deleteProperty(systemId, id) {
    return this.#write(data => {
      assertKey(systemId);
      const system = data.systems[systemId];
      requireProperty(system, id);
      delete system.properties[id];
      for (const assignments of [system.categories, system.components]) {
        for (const key of Object.keys(assignments)) assignments[key] = assignments[key].filter(value => value !== id);
      }
      system.rules.propertyOrder = system.rules.propertyOrder.filter(value => value !== id);
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

  setComponentProperties(systemId, componentId, propertyIds, { canWrite = () => true } = {}) {
    const ids = copy(propertyIds);
    return this.#write(data => {
      assertKey(componentId);
      if (!canWrite() || !persistedComponents(this.#getGame(), systemId).has(componentId)) {
        throw new Error('Component context is no longer available');
      }
      this.#system(data, systemId).components[componentId] = ids;
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
      const assignments = data.systems[systemId]?.components;
      for (const id of requested ?? Object.keys(assignments ?? {})) {
        if (assignments && !present.has(id)) delete assignments[id];
      }
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
  deleteComponent(systemId, componentId) { return this.#remove(systemId, "components", componentId); }

  configureRules(systemId, patch) {
    const values = copy(patch);
    return this.#write(data => {
      const rules = this.#system(data, systemId).rules;
      assertFields(values, Object.keys(rules));
      Object.assign(rules, values);
    });
  }

  deleteSystem(systemId) {
    return this.#write(data => { assertKey(systemId); delete data.systems[systemId]; });
  }
}
