import { emptyRecipeRules } from './data-model.js';
import { recipeContext } from './recipe-contract.js';

// Own draft/save lifecycle; Fabricate's recipe draft and dirty guards are untouched.
export function mountRecipePanel({ target, getGame, data, systemId, recipeId, canWrite, text }) {
  const doc = target.ownerDocument, panel = doc.createElement('section');
  panel.className = 'skybricate-recipe-panel'; panel.dataset.skyRecipeRules = recipeId;
  let disposed = false, pending = false, started = false, context = null, baseline = null, properties = {}, order = [];
  const el = (tag, value, parent = panel) => {
    const node = doc.createElement(tag); if (value !== undefined) node.textContent = value; parent.append(node); return node;
  };
  const button = (key, action, parent = panel) => {
    const node = el('button', text(key), parent); node.type = 'button'; node.dataset.skyRecipeAction = action; return node;
  };
  const heading = el('h2'); el('p', text('Hint'));
  const configured = el('p');
  const controls = el('fieldset');
  el('legend', text('AllowedProperties'), controls);
  const rows = el('div', undefined, controls);
  const add = button('Add', 'add', controls);
  const toggle = key => {
    const label = el('label', text(key), controls), input = el('input', undefined, label); input.type = 'checkbox';
    input.dataset.skyRecipeToggle = key; return input;
  };
  const priority = toggle('PrioritySpecial'), limited = toggle('LimitByCheck');
  const limits = el('div', undefined, controls), outcomeHint = el('p', undefined, controls);
  const save = button('Save', 'save', controls), reload = button('Reload', 'reload');
  const message = el('p', ''); message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
  const live = () => !disposed && panel.isConnected && canWrite() && getGame().user?.isGM === true;
  const error = failure => { if (!disposed) message.textContent = `${text('Error')} ${failure.message}`; };
  function state() {
    controls.disabled = pending || !live() || !context;
    reload.disabled = pending || !live();
    add.disabled = !Object.keys(properties).some(id => !order.includes(id));
    save.disabled = limited.checked && !context?.outcomes.length;
    for (const input of limits.querySelectorAll('input')) input.disabled = !limited.checked;
  }
  function renderRows() {
    rows.replaceChildren();
    if (!order.length) el('p', text('Empty'), rows);
    order.forEach((id, index) => {
      const row = el('div', undefined, rows); row.className = 'skybricate-assignment-row';
      const select = el('select', undefined, row); select.dataset.skyRecipeIndex = index;
      select.setAttribute('aria-label', text('AllowedProperty'));
      for (const [key, property] of Object.entries(properties)) {
        if (key !== id && order.includes(key)) continue;
        const option = el('option', property.name, select); option.value = key; option.title = property.description;
      }
      select.value = id;
      for (const [key, action, disabled] of [['Up', 'up', index === 0], ['Down', 'down', index === order.length - 1], ['Remove', 'remove', false]]) {
        const node = button(key, action, row); node.dataset.skyRecipeIndex = index; node.disabled = disabled;
      }
    });
    state();
  }
  function load() {
    context = null;
    if (!live()) { state(); return; }
    started = true;
    try {
      context = recipeContext(getGame(), systemId, recipeId);
      const system = data.getSnapshot().systems[systemId]; properties = system?.properties ?? {};
      baseline = structuredClone(system?.recipeRules[recipeId] ?? null);
      const rules = baseline ?? emptyRecipeRules();
      // UI writes the allowed set and its order together. API callers can omit
      // allowed IDs from propertyOrder; append those stably for editing.
      order = [...rules.propertyOrder, ...rules.allowedPropertyIds.filter(id => !rules.propertyOrder.includes(id)).sort()];
      heading.textContent = `${context.recipe.name} [${systemId} / ${recipeId}]`;
      configured.textContent = text(baseline ? 'Configured' : 'Unconfigured');
      priority.checked = rules.prioritySpecial; limited.checked = rules.limitByCheck;
      limits.replaceChildren();
      for (const outcome of context.outcomes) {
        const name = outcome.labelKey ? text(outcome.labelKey) : outcome.name;
        const label = el('label', `${name} [${outcome.id}]`, limits);
        const input = el('input', undefined, label); input.type = 'number'; input.min = '0'; input.step = '1';
        input.max = String(Number.MAX_SAFE_INTEGER); input.dataset.skyOutcome = outcome.id;
        input.value = Object.hasOwn(rules.outcomeLimits, outcome.id) ? String(rules.outcomeLimits[outcome.id]) : '0';
      }
      outcomeHint.textContent = text(context.outcomes.length ? 'OutcomeHint' : 'NoOutcomes');
      renderRows(); message.textContent = '';
    } catch (failure) { context = null; state(); error(failure); }
  }
  function change(event) {
    if (pending || !live() || !context) return;
    const index = event.target.dataset.skyRecipeIndex;
    if (index !== undefined) {
      const at = Number(index), id = event.target.value;
      if (Number.isInteger(at) && at >= 0 && at < order.length && Object.hasOwn(properties, id)
        && !order.some((value, i) => i !== at && value === id)) order[at] = id;
      renderRows();
    }
    message.textContent = ''; state();
  }
  async function click(event) {
    const node = event.target.closest?.('[data-sky-recipe-action]');
    if (!node || !panel.contains(node)) return;
    event.preventDefault(); event.stopPropagation();
    if (pending) return;
    if (!live()) { state(); message.textContent = text('Unavailable'); return; }
    try {
      if (node === reload) { load(); return; }
      if (!context) return;
      const action = node.dataset.skyRecipeAction, index = Number(node.dataset.skyRecipeIndex);
      if (action === 'add') {
        const id = Object.keys(properties).find(id => !order.includes(id)); if (id) order.push(id);
        renderRows(); return;
      }
      if (['remove', 'up', 'down'].includes(action)) {
        if (!Number.isInteger(index) || index < 0 || index >= order.length) return;
        if (action === 'remove') order.splice(index, 1);
        else {
          const next = index + (action === 'up' ? -1 : 1);
          if (next >= 0 && next < order.length) [order[index], order[next]] = [order[next], order[index]];
        }
        renderRows(); return;
      }
      if (node !== save) return;
      const outcomeLimits = {};
      for (const input of limits.querySelectorAll('input')) {
        if (!/^\d+$/.test(input.value) || !Number.isSafeInteger(Number(input.value))) throw new Error(text('InvalidLimit'));
        outcomeLimits[input.dataset.skyOutcome] = Number(input.value);
      }
      pending = true; state(); panel.setAttribute('aria-busy', 'true'); message.textContent = text('Saving');
      await data.configureRecipeRules(systemId, recipeId, { allowedPropertyIds: [...order], propertyOrder: [...order],
        prioritySpecial: priority.checked, limitByCheck: limited.checked, outcomeLimits }, {
        canWrite: live, expectedRules: baseline, expectedContext: context.revision
      });
      if (live()) { load(); message.textContent = text('Saved'); }
    } catch (failure) { error(failure); }
    finally { pending = false; if (!disposed) { panel.removeAttribute('aria-busy'); state(); } }
  }
  panel.addEventListener('change', change); panel.addEventListener('click', click); target.append(panel); load();
  return { element: panel, reload: load, start() { if (!started) load(); }, dispose() {
    disposed = true; panel.removeEventListener('change', change); panel.removeEventListener('click', click); panel.remove();
  } };
}
