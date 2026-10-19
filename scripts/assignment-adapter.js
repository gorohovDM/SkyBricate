import { mountAssignmentPanel } from './assignment-panel.js';

// ApplicationV2 is injected so imports remain safe before Foundry's init hook.
export function createAssignmentApplication({ ApplicationV2, getGame, getData, compatible }) {
  const allowed = () => getGame().user?.isGM === true && compatible() && !!getData();
  return class SkyBricateAssignments extends ApplicationV2 {
    static DEFAULT_OPTIONS = {
      classes: ['skybricate-assignments'], tag: 'div',
      window: { title: 'SKYBRICATE.Editor.AssignmentsTitle', resizable: true },
      position: { width: 620, height: 560 }
    };
    _assignments = null;
    _content = null;
    _canRender() { if (!allowed()) return false; }
    async _renderHTML() { return null; }
    _replaceHTML(result, content) {
      if (this._assignments && this._content === content) return;
      this._disposeAssignments(); this._content = content;
      this._assignments = mountAssignmentPanel({ target: content, getGame, data: getData(),
        canWrite: allowed, text: key => getGame().i18n.localize(`SKYBRICATE.Editor.${key}`) });
    }
    _disposeAssignments() { this._assignments?.dispose(); this._assignments = null; this._content = null; }
    _onRender(context, options) { super._onRender(context, options); this._assignments?.start(); }
    async close(options) { this._disposeAssignments(); return super.close(options); }
    _onClose(options) { this._disposeAssignments(); super._onClose(options); }
  };
}

export function registerAssignmentMenu(settings, Application) {
  settings.registerMenu('skybricate', 'assignments', {
    name: 'SKYBRICATE.Editor.AssignmentsTitle', label: 'SKYBRICATE.Editor.OpenAssignments',
    hint: 'SKYBRICATE.Editor.AssignmentsMenuHint', icon: 'fa-solid fa-tags',
    type: Application, restricted: true
  });
}
