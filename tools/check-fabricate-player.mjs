// Real stock registry + compiled mount host; no Foundry launch or upstream edits.
// node --conditions=browser tools/check-fabricate-player.mjs [stock checkout]
import assert from 'node:assert/strict';
import { writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compile } from 'svelte/compiler';
import { stockSources } from './fabricate-source.mjs';
import { playerFixture } from '../tests/helpers/player-fixture.mjs';

const { upstream, read } = stockSources(process.argv[2]);
const cache = resolve('node_modules/.cache'); await mkdir(cache, { recursive: true });
const temp = await mkdtemp(resolve(cache, 'skybricate-player-')), copied = new Set();
async function prepare(path) {
  if (copied.has(path)) return; copied.add(path);
  const source = read(path), out = resolve(temp, path + (path.endsWith('.svelte') ? '.js' : ''));
  await mkdir(dirname(out), { recursive: true });
  for (const match of source.matchAll(/(?:from\s*|import\s*)['"]([^'"]+)['"]/g)) {
    if (match[1].startsWith('.')) await prepare(relative(upstream, resolve(upstream, dirname(path), match[1])).replaceAll('\\', '/'));
  }
  const code = path.endsWith('.svelte') ? compile(source, { filename: path, generate: 'client', css: 'external' }).js.code : source;
  await writeFile(out, code.replace(/(from\s*['"][^'"]+)\.svelte(['"])/g, '$1.svelte.js$2'));
}
let f, app;
try {
  await prepare('src/ui/playerExtensions.js'); await prepare('src/ui/svelte/apps/PlayerExtensionHost.svelte');
  const { createPlayerExtensionsRegistry } = await import(pathToFileURL(resolve(temp, 'src/ui/playerExtensions.js')));
  const registry = createPlayerExtensionsRegistry({ emitHook() {}, reportError: (...args) => { throw Error(args.join(' ')); } });
  f = playerFixture({ registry: registry.publicApi });
  assert.equal(registry.getPlayerNavProvider('skybricate'), f.provider);
  const rootSource = read('src/ui/svelte/apps/FabricateAppRoot.svelte');
  assert(rootSource.includes('actorId: services?.actorBar?.selectedActorId || null'));
  assert(rootSource.includes("const CONTEXT_VALUE_KEYS = ['surfaceId', 'tabId', 'actorId', 'isGM', 'revision']"));
  const permissionSource = read('src/config/preferencesCleanup.js');
  assert(permissionSource.includes("actor.isOwner === true || actor.testUserPermission?.(user, 'OWNER') === true"));
  for (const key of ['window','document','navigator','Node','Element','HTMLElement','HTMLMediaElement','HTMLInputElement','HTMLFormElement','Text','Comment','Event','CustomEvent','MutationObserver','getComputedStyle','requestAnimationFrame','cancelAnimationFrame']) {
    Object.defineProperty(globalThis, key, { configurable: true, value: ['getComputedStyle','requestAnimationFrame','cancelAnimationFrame'].includes(key) ? f.window[key].bind(f.window) : f.window[key] });
  }
  const wrapper = `<script>
    import Host from './src/ui/svelte/apps/PlayerExtensionHost.svelte.js';
    let { provider, contextStore } = $props();
    let host;
    export function disposeBeforeRemoval() { host?.disposeBeforeRemoval(); }
  </script><Host bind:this={host} {provider} surfaceId="skybricate" tabId="properties" context={$contextStore}
    reportError={(...args) => { throw Error(args.join(' ')); }} emitHook={() => {}} />`;
  await writeFile(resolve(temp, 'Wrapper.js'), compile(wrapper, { filename: 'Wrapper.svelte', generate: 'client' }).js.code);
  const { mount, unmount, tick } = await import('svelte'), { writable } = await import('svelte/store');
  const { default: Wrapper } = await import(pathToFileURL(resolve(temp, 'Wrapper.js')));
  const contextStore = writable(f.context('actor'));
  app = mount(Wrapper, { target: f.root, props: { provider: f.provider, contextStore } });
  await tick(); assert.match(f.root.textContent, /Known <img>/); assert.equal(f.hooks.count('updateActor'), 1);
  assert(f.root.querySelector('[data-player-extension-mounted="skybricate"]'));
  contextStore.set(f.context('other')); await tick();
  assert.doesNotMatch(f.root.textContent, /Known <img>|Known special/); assert.equal(f.hooks.count('updateActor'), 1);
  contextStore.set(f.context(null)); await tick(); assert.match(f.root.textContent, /NoActor/);
  contextStore.set(f.context('actor')); await tick(); f.special = false;
  assert.doesNotMatch(f.root.textContent, /Known special/); assert.equal(f.writes, 0);
  app.disposeBeforeRemoval(); assert.equal(f.root.querySelector('.skybricate-player-panel'), null);
  assert.equal(f.hooks.count('updateActor'), 0);
  await unmount(app); app = null; f.dispose();
  assert.equal(registry.getPlayerNavProvider('skybricate'), null); assert.equal(f.unregisters, 1);
  console.log('PASS stock 1.9.10 player registry + compiled PlayerExtensionHost: API v1, actor context/remount, OWNER gate, hidden special, connected cleanup, unregister, read-only.');
} finally { if (app) { const { unmount } = await import('svelte'); await unmount(app); } f?.destroy(); await rm(temp, { recursive: true, force: true }); }
