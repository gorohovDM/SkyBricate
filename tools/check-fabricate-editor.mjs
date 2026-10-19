// Optional, explicit contract probe. Ordinary regression tests do not need
// .reference. Run: node --conditions=browser tools/check-fabricate-editor.mjs
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { compile } from "svelte/compiler";
import { emptyData } from "../scripts/data-model.js";
import { managerFixture, settleDOM } from "../tests/helpers/manager-fixture.mjs";

const upstream = resolve(process.argv[2] ?? ".reference/fabricate");
assert.equal(execFileSync("git", ["-C", upstream, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  "5bf36ddf950619317e41737acd3bfa1305591a26", "Probe requires Fabricate v1.9.10 source SHA");
const files = ["CraftingSettingsView", "ResolutionModeCard", "RadioCardGroup", "CraftingEffectPanel"];
execFileSync("git", ["-C", upstream, "diff", "--exit-code", "HEAD", "--",
  "src/ui/SvelteCraftingSystemManagerApp.svelte.js", "src/ui/svelte/SvelteApplicationMixinCore.js",
  "src/ui/svelte/stores/adminStore.js", "src/ui/svelte/stores/adminSystemInspectorProjection.js",
  ...files.map(name => `src/ui/svelte/apps/manager/${name}.svelte`), "src/ui/svelte/apps/manager/resolutionModeOptions.js"]);
const dir = resolve(upstream, "src/ui/svelte/apps/manager");
const appSource = await readFile(resolve(upstream, "src/ui/SvelteCraftingSystemManagerApp.svelte.js"), "utf8");
assert(appSource.includes("id: 'fabricate-crafting-system-manager'"));
assert(appSource.includes("_adminStore = null"));
const projection = await readFile(resolve(upstream, "src/ui/svelte/stores/adminSystemInspectorProjection.js"), "utf8");
assert(projection.includes("id: selectedSystem.id"));
assert(projection.includes("resolutionMode: selectedSystem.resolutionMode || 'simple'"));
const mixin = await readFile(resolve(upstream, "src/ui/svelte/SvelteApplicationMixinCore.js"), "utf8");
assert(mixin.includes("_replaceHTML(result, content, options)"));
assert(mixin.includes("this._svelteComponent = mountFn(Component"));
const storeSource = await readFile(resolve(upstream, "src/ui/svelte/stores/adminStore.js"), "utf8");
assert(storeSource.includes("selectedSystemId.set(systemId)"));
assert(storeSource.includes("await services.setSetting('lastManagedCraftingSystem', systemId)"));

const cacheRoot = resolve("node_modules/.cache"); await mkdir(cacheRoot, { recursive: true });
const temp = await mkdtemp(resolve(cacheRoot, "skybricate-contract-"));
const f = managerFixture({ getSnapshot: emptyData });
try {
  for (const key of ["window", "document", "navigator", "Node", "Element", "HTMLElement", "Text", "Comment", "Event", "CustomEvent", "MutationObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"])
    Object.defineProperty(globalThis, key, { configurable: true, value: typeof f.window[key] === "function" && ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"].includes(key) ? f.window[key].bind(f.window) : f.window[key] });
  // Production store semantics and production component DOM. Only Foundry's
  // localization bridge is stubbed; the component/controller files are unedited.
  await writeFile(resolve(temp, "localize.js"), "export const localize = key => key;\n");
  await writeFile(resolve(temp, "resolutionModeOptions.js"), await readFile(resolve(dir, "resolutionModeOptions.js")));
  for (const name of files) {
    const source = await readFile(resolve(dir, `${name}.svelte`), "utf8");
    const { js } = compile(source, { filename: `${name}.svelte`, generate: "client", css: "external" });
    await writeFile(resolve(temp, `${name}.svelte.js`), js.code
      .replaceAll("../../util/foundryBridge.js", "./localize.js")
      .replace(/(\.\/\w+)\.svelte(['"])/g, "$1.svelte.js$2"));
  }
  const wrapper = `<script>
    import Settings from './CraftingSettingsView.svelte.js';
    let { store, visible, onMode } = $props(); const state = store.viewState;
    </script>{#if $visible}<Settings selectedSystem={$state.selectedSystem} onSetResolutionMode={onMode} />{/if}`;
  await writeFile(resolve(temp, "Wrapper.js"), compile(wrapper, { filename: "Wrapper.svelte", generate: "client" }).js.code);
  const { mount, unmount, tick } = await import("svelte");
  const { writable } = await import("svelte/store");
  const { default: Wrapper } = await import(pathToFileURL(resolve(temp, "Wrapper.js")));
  f.root.replaceChildren();
  const selectedSystemId = writable("a"), viewState = writable({ selectedSystem: { id: "a", name: "A", resolutionMode: "alchemy" } });
  const store = { selectedSystemId, viewState }, visible = writable(true);
  f.app._adminStore = store;
  let acceptMode;
  const component = mount(Wrapper, { target: f.root, props: { store, visible,
    onMode: () => new Promise(resolve => { acceptMode = resolve; }) } });
  await tick(); f.render(); await settleDOM();
  assert.equal(f.panel()?.dataset.skybricatePanel, "a");
  const first = f.panel(); f.render(); await tick(); await settleDOM(); assert.equal(f.panel(), first);
  selectedSystemId.set("b"); assert.equal(f.panel(), null);
  await settleDOM(); assert.equal(f.panel(), null); // before async viewState refresh
  viewState.set({ selectedSystem: { id: "b", name: "B", resolutionMode: "alchemy" } });
  await tick(); await settleDOM(); assert.equal(f.panel()?.dataset.skybricatePanel, "b");
  const radio = f.root.querySelector('[data-crafting-resolution-mode] input[value="simple"]');
  radio.click(); await tick(); await settleDOM(); assert.equal(f.panel(), null);
  acceptMode(false); await tick(); await settleDOM(); assert(f.panel()); // native cancellation restores alchemy
  viewState.set({ selectedSystem: { id: "b", name: "B", resolutionMode: "simple" } });
  await tick(); await settleDOM(); assert.equal(f.panel(), null);
  viewState.set({ selectedSystem: { id: "b", name: "B", resolutionMode: "alchemy" } });
  await tick(); await settleDOM(); assert(f.panel());
  visible.set(false); await tick(); await settleDOM(); assert.equal(f.panel(), null);
  visible.set(true); await tick(); await settleDOM(); assert(f.panel());
  assert.equal(f.root.querySelectorAll('[data-skybricate-panel]').length, 1);
  const count = f.observerCallbacks; await settleDOM(); assert.equal(f.observerCallbacks, count);
  f.close(); await unmount(component); await settleDOM(); assert.equal(f.observerCount, 0); assert.equal(f.warnings.length, 0);
  console.log("Fabricate 1.9.10 actual Svelte settings: mount, async selection, optimistic radio cancellation, mode changes, navigation/remount, no duplicate/feedback, close PASS.");
} finally {
  f.destroy();
  await rm(temp, { recursive: true, force: true });
}
