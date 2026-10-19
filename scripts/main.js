import { DataStore, registerDataSetting } from "./data-store.js";

export const MODULE_ID = "skybricate";
export const FABRICATE_VERSION = "1.9.10";

// No providers or crafting adapters are registered by the scaffold.
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
    || typeof fabricate?.api?.playerExtensions?.registerPlayerNavProvider !== "function") return "api";
  return null;
}

export function installLifecycle({ hooks, getGame, notifications, logger = console }) {
  let foundryReady = false;
  let waiting = false;
  let terminal = false;
  const status = { ready: false, reason: null };
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
      if (module) module.api = Object.freeze({ data: new DataStore({ getGame }) });
      terminal = true;
      status.ready = true;
      logger.info("SkyBricate | Data layer ready; gameplay features are not implemented.");
    }).catch(() => fail("initialization"));
  };
  hooks.once("init", () => registerDataSetting(getGame().settings));
  hooks.once("ready", () => { foundryReady = true; attempt(); });
  hooks.on("fabricate.ready", attempt);
  return status;
}

if (globalThis.Hooks) {
  installLifecycle({ hooks: globalThis.Hooks, getGame: () => globalThis.game,
    notifications: () => globalThis.ui?.notifications });
}
