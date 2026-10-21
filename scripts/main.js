import { DataStore, registerDataSetting } from "./data-store.js";
import { installManagerAdapter } from "./manager-adapter.js";
import { createAssignmentApplication, registerAssignmentMenu } from './assignment-adapter.js';
import { createKnowledgeApplication, registerKnowledgeMenu } from './knowledge-adapter.js';
import { installPlayerProvider } from './player-provider.js';
import { createRecipeApplication } from './recipe-adapter.js';

import { selectProperties } from './property-selection.js';
import { installCraftAdapter } from './craft-adapter.js';
import { installCraftDiscovery } from './craft-discovery.js';

export const MODULE_ID = "skybricate";
export const FABRICATE_VERSION = "1.9.10";

export function checkCompatibility(game) {
  const dependency = game.modules?.get("fabricate");
  if (!dependency?.active) return "dependency";
  if (dependency.version !== FABRICATE_VERSION) return "version";
  if (![13, 14].includes(Number(game.release?.generation))) return "foundry";
  const fabricate = game.fabricate;
  if (typeof fabricate?.whenReady !== "function"
    || typeof fabricate?.getCraftingSystemManager !== "function"
    || typeof fabricate?.getRecipeManager !== "function"
    || typeof fabricate?.getCraftingRunManager !== "function"
    || typeof fabricate?.getCraftingEngine !== "function"
    || typeof fabricate?.api?.playerExtensions?.registerPlayerNavProvider !== "function") return "api";
  return null;
}

export function installLifecycle({ hooks, getGame, notifications, logger = console,
  getApplicationV2 = () => globalThis.foundry?.applications?.api?.ApplicationV2 }) {
  let foundryReady = false;
  let waiting = false;
  let terminal = false;
  const status = { ready: false, reason: null };
  let data = null, AssignmentApplication = null, KnowledgeApplication = null, RecipeApplication = null;
  const fail = (reason) => {
    terminal = true;
    status.reason = reason;
    logger.warn(`SkyBricate | Disabled: ${reason}`);
    const game = getGame();
    if (game.user?.isGM) notifications()?.warn(game.i18n.localize(`SKYBRICATE.Compatibility.${reason}`));
  };
  const attempt = () => {
    if (!foundryReady || terminal || waiting) return;
    const problem = checkCompatibility(getGame());
    if (problem) return fail(problem);
    const fabricate = getGame().fabricate;
    waiting = true;
    Promise.resolve().then(() => fabricate.whenReady()).then(() => {
      const problem = checkCompatibility(getGame());
      if (problem) return fail(problem);
      const module = getGame().modules.get(MODULE_ID);
      data = new DataStore({ getGame });
      installCraftDiscovery({ hooks, getGame, data, logger });
      installCraftAdapter({ engine: fabricate.getCraftingEngine(), getGame, data, logger });
      installPlayerProvider({ getGame, data, hooks, compatible: () => checkCompatibility(getGame()) === null });
      const openAssignments = () => {
        if (!AssignmentApplication || !getGame().user?.isGM || checkCompatibility(getGame()) !== null) {
          throw new Error('SkyBricate assignments are unavailable');
        }
        return new AssignmentApplication().render({ force: true });
      };
      const openKnowledge = () => {
        if (!KnowledgeApplication || !getGame().user?.isGM || checkCompatibility(getGame()) !== null) {
          throw new Error('SkyBricate knowledge is unavailable');
        }
        return new KnowledgeApplication().render({ force: true });
      };
      const openRecipeRules = (systemId, recipeId, contextAvailable = () => true) => {
        if (!RecipeApplication || !getGame().user?.isGM || checkCompatibility(getGame()) !== null) throw new Error('Recipe rules are unavailable');
        return new RecipeApplication({ systemId, recipeId, contextAvailable }).render({ force: true });
      };
      if (module) module.api = Object.freeze({ data, openAssignments, openKnowledge, openRecipeRules, selectProperties });
      if (getGame().user?.isGM) installManagerAdapter({ hooks, getGame, data, notifications,
        openAssignments, openRecipeRules,
        compatible: () => checkCompatibility(getGame()) === null });
      terminal = true;
      status.ready = true;
      logger.info("SkyBricate | Property editors and player knowledge view ready.");
    }).catch(() => fail("initialization"));
  };
  hooks.once("init", () => {
    registerDataSetting(getGame().settings);
    const ApplicationV2 = getApplicationV2();
    if (ApplicationV2) {
      AssignmentApplication = createAssignmentApplication({ ApplicationV2, getGame, getData: () => data,
        compatible: () => checkCompatibility(getGame()) === null });
      registerAssignmentMenu(getGame().settings, AssignmentApplication);
      KnowledgeApplication = createKnowledgeApplication({ ApplicationV2, getGame, getData: () => data,
        compatible: () => checkCompatibility(getGame()) === null });
      registerKnowledgeMenu(getGame().settings, KnowledgeApplication);
      RecipeApplication = createRecipeApplication({ ApplicationV2, getGame, getData: () => data,
        compatible: () => checkCompatibility(getGame()) === null });
    }
  });
  hooks.once("ready", () => { foundryReady = true; attempt(); });
  hooks.on("fabricate.ready", attempt);
  return status;
}

if (globalThis.Hooks) {
  installLifecycle({ hooks: globalThis.Hooks, getGame: () => globalThis.game,
    notifications: () => globalThis.ui?.notifications });
}
