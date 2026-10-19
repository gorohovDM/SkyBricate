// Optional actual-upstream contract probe; never required by normal regression.
// node --conditions=browser tools/check-fabricate-editor.mjs [upstream checkout]
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve, dirname, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { compile } from "svelte/compiler";
import { emptyData } from "../scripts/data-model.js";
import { managerFixture, settleDOM } from "../tests/helpers/manager-fixture.mjs";
import { stockSources } from './fabricate-source.mjs';

const { upstream, read: readStock } = stockSources(process.argv[2]);
const cacheRoot = resolve("node_modules/.cache"); await mkdir(cacheRoot, { recursive: true });
const temp = await mkdtemp(resolve(cacheRoot, "skybricate-contract-"));
let assignmentOpens = 0;
const f = managerFixture({ getSnapshot: emptyData }, { openAssignments: () => { assignmentOpens++; } });
const copied = new Set();
async function prepare(path) {
  if (copied.has(path)) return;
  copied.add(path);
  const source = readStock(path);
  const out = resolve(temp, path + (path.endsWith(".svelte") ? ".js" : ""));
  await mkdir(dirname(out), { recursive: true });
  if (path.endsWith("foundryBridge.js")) {
    await writeFile(out, "export const localize = key => key;\n"); return;
  }
  for (const match of source.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g)) {
    if (match[1].startsWith(".")) await prepare(relative(upstream, resolve(upstream, dirname(path), match[1])).replaceAll("\\", "/"));
  }
  const code = path.endsWith(".svelte") ? compile(source, { filename: path, generate: "client", css: "external" }).js.code : source;
  await writeFile(out, code.replace(/(from\s*['"][^'"]+)\.svelte(['"])/g, "$1.svelte.js$2"));
}
try {
  for (const key of ["window", "document", "navigator", "Node", "Element", "HTMLElement", "HTMLMediaElement", "HTMLInputElement", "HTMLFormElement", "Text", "Comment", "Event", "CustomEvent", "MutationObserver", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"])
    Object.defineProperty(globalThis, key, { configurable: true, value: typeof f.window[key] === "function" && ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"].includes(key) ? f.window[key].bind(f.window) : f.window[key] });
  await prepare("src/ui/svelte/apps/manager/TagsCategoriesView.svelte");
  const contractFiles = ["src/ui/SvelteCraftingSystemManagerApp.svelte.js", "src/ui/svelte/SvelteApplicationMixinCore.js",
    "src/ui/svelte/stores/adminStore.js", "src/ui/svelte/stores/adminSystemInspectorProjection.js", "src/ui/svelte/apps/manager/CraftingSystemManagerRoot.svelte"];
  const appSource = readStock(contractFiles[0]);
  assert(appSource.includes("id: 'fabricate-crafting-system-manager'")); assert(appSource.includes("_adminStore = null"));
  const mixin = readStock(contractFiles[1]);
  assert(mixin.includes("_replaceHTML(result, content, options)")); assert(mixin.includes("this._svelteComponent = mountFn(Component"));
  const adminStore = readStock(contractFiles[2]);
  assert(adminStore.includes("selectedSystemId.set(systemId)"));
  assert(adminStore.includes("await services.setSetting('lastManagedCraftingSystem', systemId)"));
  const projection = readStock(contractFiles[3]);
  assert(projection.includes("id: selectedSystem.id")); assert(projection.includes("resolutionMode: selectedSystem.resolutionMode || 'simple'"));
  const rootSource = readStock(contractFiles.at(-1));
  const headerMarkup = '<div class="manager-header-actions" aria-label={headerActionsLabel()}>';
  assert(rootSource.includes(headerMarkup));
  assert(rootSource.includes('onTabChange={(id) => (tagsActiveTab = id)}'));
  assert(rootSource.includes('activeTab={tagsActiveTab}'));
  const wrapper = `<script>
    import Tags from './src/ui/svelte/apps/manager/TagsCategoriesView.svelte.js';
    let { store, visible, nativeAdd } = $props(); const view = store.viewState;
    let active = $state('recipe');
    const headerActionsLabel = () => 'Actions';
    </script>${headerMarkup}<button type="button">Native action</button></div>{#if $visible && $view.selectedSystem}<Tags activeTab={active} onTabChange={id => active = id} onAddCategory={nativeAdd} />{/if}`;
  await writeFile(resolve(temp, "Wrapper.js"), compile(wrapper, { filename: "Wrapper.svelte", generate: "client" }).js.code);
  const { mount, unmount, tick } = await import("svelte"), { writable } = await import("svelte/store");
  const { default: Wrapper } = await import(pathToFileURL(resolve(temp, "Wrapper.js")));
  f.root.replaceChildren();
  const selectedSystemId = writable("a"), viewState = writable({ selectedSystem: { id: "a", name: "A", resolutionMode: "simple" } });
  const store = { selectedSystemId, viewState }, visible = writable(true); f.app._adminStore = store;
  let nativeAdds = 0;
  const component = mount(Wrapper, { target: f.root, props: { store, visible, nativeAdd: () => { nativeAdds++; } } });
  const settle = async () => { await tick(); await settleDOM(); };
  const ownTab = () => f.root.querySelector('[data-skybricate-tab]');
  const nativeTab = id => f.root.querySelector(`[data-vocabulary-tab="${id}"]`);
  const key = (node, value) => node.dispatchEvent(new f.window.KeyboardEvent("keydown", { key: value, bubbles: true }));
  await settle(); f.render(); await settle();
  const assignments = () => f.root.querySelector('[data-skybricate-assignments]');
  assert(assignments()); assignments().click(); await settle(); assert.equal(assignmentOpens, 1);
  assert(ownTab()); assert.equal(f.panel(), null); assert.equal(f.root.querySelectorAll('[role="tab"]').length, 4);
  ownTab().click(); await settle(); assert.equal(f.panel()?.dataset.skybricatePanel, "a");
  assert.equal(nativeTab("recipe").getAttribute("aria-selected"), "false");
  assert.equal(f.root.querySelector('#vocabulary-panel-recipe').hidden, true);
  assert.equal(ownTab().getAttribute("aria-selected"), "true");
  const first = f.panel(); f.render(); await settle(); assert.equal(f.panel(), first);
  const count = f.observerCallbacks; await settle(); assert.equal(f.observerCallbacks, count);
  key(ownTab(), "ArrowRight"); await settle(); assert.equal(nativeTab("recipe").getAttribute("aria-selected"), "true");
  assert.equal(f.panel(), null); assert.equal(f.root.querySelector('#vocabulary-panel-recipe').hidden, false);
  nativeTab("tag").click(); await settle(); assert(f.root.querySelector('#vocabulary-panel-tag'));
  key(nativeTab("tag"), "ArrowRight"); await settle(); assert(f.panel()); assert.equal(f.window.document.activeElement, ownTab());
  key(ownTab(), "Home"); await settle(); assert.equal(f.window.document.activeElement, nativeTab("recipe"));
  key(nativeTab("recipe"), "End"); await settle(); assert(f.panel());
  key(ownTab(), "ArrowLeft"); await settle(); assert.equal(nativeTab("tag").getAttribute("aria-selected"), "true");
  // Existing form handler and native controlled state remain operational.
  nativeTab("recipe").click(); await settle();
  const input = f.root.querySelector('#manager-category-add'); input.value = "Native category";
  input.dispatchEvent(new f.window.Event("input", { bubbles: true })); await tick();
  f.root.querySelector('[data-inline-vocabulary-add]').dispatchEvent(new f.window.Event("submit", { bubbles: true, cancelable: true }));
  await settle(); assert.equal(nativeAdds, 1);
  ownTab().click(); selectedSystemId.set("b"); assert.equal(f.panel(), null);
  await settle(); assert.equal(ownTab(), null);
  viewState.set({ selectedSystem: { id: "b", resolutionMode: "alchemy" } }); await settle();
  ownTab().click(); assert.equal(f.panel()?.dataset.skybricatePanel, "b");
  visible.set(false); await settle(); assert.equal(f.panel(), null); assert.equal(ownTab(), null);
  assignments().click(); await settle(); assert.equal(assignmentOpens, 2);
  visible.set(true); await settle(); assert(ownTab(), JSON.stringify({warnings:f.warnings,html:f.root.innerHTML})); assert.equal(f.panel(), null);
  ownTab().click(); f.close(); await settle();
  assert.equal(f.root.querySelector('[role="tab"][aria-selected="true"]').dataset.vocabularyTab, "recipe");
  assert.equal(f.root.querySelector('[role="tabpanel"]').hidden, false);
  assert.equal(f.observerCount, 0); assert.equal(f.warnings.length, 0);
  assert.equal(assignments(), null);
  await unmount(component);
  console.log("Fabricate 1.9.10 actual TagsCategoriesView + VocabularyPanel: native tabs/forms, 4-tab keyboard/ARIA, selection gap, navigation/rerender, restoration/close PASS.");
} finally { f.destroy(); await rm(temp, { recursive: true, force: true }); }
