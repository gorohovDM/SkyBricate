import { Window } from 'happy-dom';
import assert from 'node:assert/strict';
import { hookBus } from './manager-fixture.mjs';
import { DataStore, registerDataSetting } from '../../scripts/data-store.js';
import { emptyData, emptySystem } from '../../scripts/data-model.js';
import { installPlayerProvider } from '../../scripts/player-provider.js';

export function playerFixture({ registry } = {}) {
  const window = new Window(), root = window.document.createElement('div'); window.document.body.append(root);
  const hooks = hookBus(), configs = new Map(), actors = new Map(['actor','other'].map(id => [id, {id,isOwner:true}]));
  let snapshot = emptyData(), special = true, writes = 0, unregisters = 0, provider;
  const corpus = ['a','b'].map(id => ({id,name:`System ${id}`,components:[{id:'c',name:'Public herb'},{id:'d',name:'Public stone'}]}));
  for (const id of ['a','b']) snapshot.systems[id] = { ...emptySystem(),
    properties: {p:{name:'Known <img>',description:'Public healing'},secretid:{name:'SealedName',description:'SealedDescription'},s:{name:'Known special',description:'Special description'}},
    components: {c:['p','secretid'],d:['p']}, specialComponents: {c:['s']} };
  snapshot.knowledge = {actor:{a:{c:['p','s']}}};
  const game = {user:{id:'user',isGM:false},actors:{get:id=>actors.get(id)},i18n:{localize:key=>key.split('.').at(-1)},
    modules:new Map([['fabricate',{active:true,version:'1.9.10'}]]),settings:{
      settings:new Map([['fabricate.craftingSystems',{scope:'world',type:Array}]]),
      register:(ns,key,config)=>configs.set(key,config),
      get:(ns,key)=>structuredClone(ns==='fabricate'?corpus:key==='showSpecialProperties'?special:snapshot),
      set:()=>{writes++;throw Error('Player panel must never write');}
    },fabricate:{api:{playerExtensions:{registerPlayerNavProvider(value){assert.equal(provider,undefined);provider=value;const remove=registry?.registerPlayerNavProvider(value);return()=>{remove?.();unregisters++;};}}}}};
  registerDataSetting(game.settings);
  const data = new DataStore({getGame:()=>game});
  const dispose = installPlayerProvider({getGame:()=>game,data,hooks,compatible:()=>game.modules.get('fabricate').version==='1.9.10'});
  const context = actorId => Object.freeze({schemaVersion:1,surface:'player',surfaceId:'skybricate',tabId:'properties',actorId,isGM:false,revision:0,requestRemount(){}});
  return {window,root,hooks,game,data,actors,corpus,configs,provider,context,dispose,
    mount(actor='actor'){return provider.mount({target:root,tabId:'properties',context:context(actor)});},
    notify(){configs.get('data').onChange();},
    set special(value){special=value;configs.get('showSpecialProperties').onChange();},
    get snapshot(){return structuredClone(snapshot);},replace(value){snapshot=structuredClone(value);},
    get writes(){return writes;},get unregisters(){return unregisters;},
    destroy(){dispose();window.happyDOM.abort();}};
}
