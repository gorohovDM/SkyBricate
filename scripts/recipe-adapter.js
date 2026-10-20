import { mountRecipePanel } from './recipe-panel.js';
import { recipeContext } from './recipe-contract.js';

export function createRecipeApplication({ ApplicationV2, getGame, getData, compatible }) {
  return class SkyBricateRecipeRules extends ApplicationV2 {
    static DEFAULT_OPTIONS = {
      classes: ['skybricate-recipe-rules'], tag: 'div',
      window: { title: 'SKYBRICATE.Recipe.Title', resizable: true }, position: { width: 650, height: 580 }
    };
    constructor({ systemId, recipeId, contextAvailable = () => true }) {
      super({}); this.systemId = systemId; this.recipeId = recipeId; this.contextAvailable = contextAvailable;
    }
    _panel = null;
    _content = null;
    _allowed = () => getGame().user?.isGM === true && compatible() && !!getData() && this.contextAvailable();
    _canRender() {
      if (!this._allowed()) return false;
      try { recipeContext(getGame(), this.systemId, this.recipeId); } catch { return false; }
    }
    async _renderHTML() { return null; }
    _replaceHTML(result, content) {
      if (this._panel && content === this._content) return;
      this._dispose(); this._content = content;
      this._panel = mountRecipePanel({ target: content, getGame, data: getData(), systemId: this.systemId,
        recipeId: this.recipeId, canWrite: this._allowed, text: key => getGame().i18n.localize(`SKYBRICATE.Recipe.${key}`) });
    }
    _dispose() { this._panel?.dispose(); this._panel = null; this._content = null; }
    _onRender(context, options) { super._onRender(context, options); this._panel?.start(); }
    async close(options) { this._dispose(); return super.close(options); }
    _onClose(options) { this._dispose(); super._onClose(options); }
  };
}
