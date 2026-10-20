import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { DataStore, registerDataSetting } from '../scripts/data-store.js';
import { emptyData, readData } from '../scripts/data-model.js';
import { mountKnowledgePanel } from '../scripts/knowledge-panel.js';
import { createKnowledgeApplication, registerKnowledgeMenu } from '../scripts/knowledge-adapter.js';

const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
async function fixture() {
  let stored = emptyData(), writes = 0, reject = false, gate = null, special = true;
  const registrations = new Map();
  const corpus = ['a','b'].map(id => ({id, components: [{id:'c'}, {id:'d'}]}));
  const actors = new Map(['actor','other'].map(id => [id,{id, name:'<img src=x>', type:'arbitrary'}]));
  const game = { i18n:{localize:key=>key}, user:{isGM:true}, actors:{ get:id=>actors.get(id), get contents(){return [...actors.values()];}},
    modules:new Map([['fabricate',{active:true,version:'1.9.10'}]]), settings:{
      register:(ns,key,config)=>registrations.set(key,config),
      settings:new Map([['fabricate.craftingSystems',{scope:'world',type:Array}]]),
      get:(ns,key)=>ns==='fabricate'?structuredClone(corpus):key==='showSpecialProperties'?special:structuredClone(stored),
      set:async(ns,key,value)=>{if(gate) await gate; if(reject)throw Error('failed save');stored=structuredClone(value);writes++;}
    }};
  registerDataSetting(game.settings);
  const data = new DataStore({getGame:()=>game,idFactory:()=> 'p'});
  for (const system of ['a','b']) { await data.createProperty(system,{name:'<script>',description:'<img>'});
    for(const component of ['c','d'])await data.setComponentAssignments(system,component,{ordinary:['p'],special:[]},{editSpecial:true}); }
  return {game,data,actors,corpus, get snapshot(){return structuredClone(stored);},get writes(){return writes;},
    set reject(v){reject=v;},set gate(v){gate=v;},set special(v){special=v;registrations.get('showSpecialProperties').onChange();},
    replace(v){stored=structuredClone(v);}};
}
const set = (f, known=true, ...context) => f.data.setPropertyKnowledge(...(context.length?context:['actor','a','c','p']),known);
const known = (f, actor='actor', system='a', component='c') => f.snapshot.knowledge[actor]?.[system]?.[component] ?? [];

test('knowledge persisted roundtrip isolates actor, system and component; rename preserves IDs; all GMs may write', async()=>{
  const f=await fixture(); await set(f); assert.deepEqual(known(f),['p']);
  assert.deepEqual(known(f,'other'),[]); assert.deepEqual(known(f,'actor','b'),[]);assert.deepEqual(known(f,'actor','a','d'),[]);
  const fresh=new DataStore({getGame:()=>f.game}); assert.deepEqual(fresh.getSnapshot(),f.snapshot);
  await f.data.updateProperty('a','p',{name:'Renamed'});f.actors.get('actor').name='Renamed';assert.deepEqual(known(f),['p']);
  f.game.user={isGM:true,id:'second-gm'}; await set(f,false);assert.deepEqual(known(f),[]);
});

test('knowledge follows assignment identity, preserves hidden special links, clears on removal and readdition', async()=>{
  const f=await fixture();await set(f);
  await f.data.setComponentAssignments('a','c',{ordinary:[],special:['p']},{editSpecial:true});assert.deepEqual(known(f),['p']);
  f.special=false;await f.data.setComponentProperties('a','c',[]);assert.deepEqual(known(f),['p']);
  f.special=true;await f.data.setComponentAssignments('a','c',{ordinary:[],special:[]},{editSpecial:true});assert.deepEqual(known(f),[]);
  await f.data.setComponentProperties('a','c',['p']);assert.deepEqual(known(f),[]);
});

test('knowledge cleanup is atomic with property/component/system deletes and reconciliation; failed save changes nothing', async()=>{
  for(const operation of ['property','component','system','reconcileComponent','reconcileAll','absentSystem']){
    const f=await fixture();await set(f);await set(f,true,'other','b','c','p');const before=f.snapshot;
    const mutate=()=>operation==='property'?f.data.deleteProperty('a','p'):operation==='component'?f.data.deleteComponent('a','c'):
      operation==='system'?f.data.deleteSystem('a'):operation==='reconcileComponent'?f.data.reconcileComponentProperties('a'):f.data.reconcileAllComponentProperties();
    if(operation==='reconcileComponent'||operation==='reconcileAll')f.corpus[0].components=[];
    if(operation==='absentSystem')f.corpus.splice(0,1);
    f.reject=true;await assert.rejects(mutate());assert.deepEqual(f.snapshot,before);f.reject=false;
    const writes=f.writes;await mutate();assert.equal(f.writes,writes+1);assert.deepEqual(known(f),[]);assert.deepEqual(known(f,'other','b'),['p']);
  }
});

test('queued knowledge checks GM, live actor/system/component/assignment and window context when executed', async()=>{
  for(const invalidate of [f=>{f.game.user.isGM=false;},f=>f.actors.delete('actor'),f=>f.corpus.splice(0,1),f=>{f.corpus[0].components=[];},f=>{const v=f.snapshot;v.systems.a.components.c=[];f.replace(v);}]){
    const f=await fixture(),before=f.snapshot;const promise=set(f);invalidate(f);await assert.rejects(promise);assert.deepEqual(f.snapshot.knowledge,before.knowledge);
  }
  const f=await fixture();let live=true;const promise=f.data.setPropertyKnowledge('actor','a','c','p',true,{canWrite:()=>live});live=false;await assert.rejects(promise);
  for(const args of [['actor','a','c','p','yes'],['actor','a','c','missing',true],['__proto__','a','c','p',true]])await assert.rejects(f.data.setPropertyKnowledge(...args));
  f.reject=true;await assert.rejects(set(f));f.reject=false;await set(f);assert.deepEqual(known(f),['p']);
});

test('invalid persisted Fabricate corpus fails closed without deleting existing knowledge', async()=>{
  const f=await fixture();await set(f);const before=f.snapshot,writes=f.writes;
  f.corpus.push({id:'malformed'});
  await assert.rejects(f.data.reconcileAllComponentProperties());await assert.rejects(set(f,false));
  assert.deepEqual(f.snapshot,before);assert.equal(f.writes,writes);
});

test('schema 2/3 migrate losslessly only on successful write; corrupt/future knowledge never resets', async()=>{
  for(const version of [2,3]){
    const f=await fixture();if(version===3)await f.data.setComponentAssignments('a','c',{ordinary:[],special:['p']},{editSpecial:true});
    const old=f.snapshot;old.schemaVersion=version;delete old.knowledge; for(const system of Object.values(old.systems)) delete system.recipeRules;
    if(version===2)for(const system of Object.values(old.systems))delete system.specialComponents;
    f.replace(old);const expectedSystems=f.data.getSnapshot().systems;const writes=f.writes;assert.equal(f.data.getSnapshot().schemaVersion,5);assert.equal(f.writes,writes);assert.deepEqual(f.snapshot,old);
    f.reject=true;await assert.rejects(set(f));assert.deepEqual(f.snapshot,old);f.reject=false;await set(f);assert.equal(f.snapshot.schemaVersion,5);
    assert.deepEqual(f.snapshot.systems,expectedSystems);assert.deepEqual(known(f),['p']);
  }
  for(const mutate of [v=>v.schemaVersion=99,v=>v.knowledge={actor:{a:{c:['missing']}}},v=>v.knowledge={actor:{a:{c:['p','p']}}},v=>v.extra=true]){
    const f=await fixture(),v=f.snapshot;mutate(v);f.replace(v);assert.throws(()=>readData(v));await assert.rejects(set(f));assert.deepEqual(f.snapshot,v);
  }
});

test('GM knowledge panel switches contexts, renders safe text, retries failure and hides special without forgetting', async t=>{
  const f=await fixture(),window=new Window();t.after(()=>window.happyDOM.abort());const root=window.document.createElement('div');window.document.body.append(root);
  const panel=mountKnowledgePanel({target:root,getGame:()=>f.game,data:f.data,canWrite:()=>true,text:key=>key});t.after(()=>panel.dispose());await settle();
  const toggle=()=>root.querySelector('[data-sky-knowledge-property]'),status=()=>root.querySelector('[role=status]').textContent;
  assert.equal(root.querySelector('img'),null);assert.equal(root.querySelector('script'),null);assert.match(root.textContent,/Unknown/);
  f.reject=true;toggle().click();await settle();assert.match(status(),/Error/);assert.deepEqual(known(f),[]);
  f.reject=false;toggle().click();await settle();assert.match(status(),/Saved/);assert.deepEqual(known(f),['p']);
  const actor=root.querySelector('[data-sky-knowledge-select=actor]');actor.value='other';actor.dispatchEvent(new window.Event('change',{bubbles:true}));assert.match(root.textContent,/Unknown/);
  actor.value='actor';actor.dispatchEvent(new window.Event('change',{bubbles:true}));assert.match(root.textContent,/Known/);
  await f.data.setComponentAssignments('a','c',{ordinary:[],special:['p']},{editSpecial:true});await panel.refresh();
  f.special=false;assert.equal(toggle(),null);assert.deepEqual(known(f),['p']);f.special=true;assert.match(root.textContent,/Known/);
  toggle().click();await settle();assert.deepEqual(known(f),[]);
  f.game.user.isGM=false;toggle().click();await settle();assert.deepEqual(known(f),[]);assert.equal(root.querySelector('fieldset').disabled,true);
});

test('knowledge pending navigation/duplicate clicks and detached/closed queued windows cannot change another context', async t=>{
  const f=await fixture(),window=new Window();t.after(()=>window.happyDOM.abort());const root=window.document.createElement('div');window.document.body.append(root);
  const panel=mountKnowledgePanel({target:root,getGame:()=>f.game,data:f.data,canWrite:()=>true,text:key=>key});await settle();
  let release;f.gate=new Promise(resolve=>{release=resolve;});const blocker=f.data.updateProperty('a','p',{name:'Queued'});await settle();
  root.querySelector('[data-sky-knowledge-property]').click();root.querySelector('[data-sky-knowledge-property]').click();const actor=root.querySelector('[data-sky-knowledge-select=actor]');actor.value='other';actor.dispatchEvent(new window.Event('change',{bubbles:true}));assert.equal(actor.value,'actor');
  panel.dispose();release();f.gate=null;await blocker;await settle();assert.deepEqual(known(f),[]);
});

test('knowledge ApplicationV2 restricted menu, detached render/start, close and GM checks',async t=>{
  const f=await fixture(),window=new Window();t.after(()=>window.happyDOM.abort());let registration;
  class Base { _onRender(){} _onClose(){} async close(){} }
  const Application=createKnowledgeApplication({ApplicationV2:Base,getGame:()=>f.game,getData:()=>f.data,compatible:()=>true});
  registerKnowledgeMenu({registerMenu:(...args)=>registration=args},Application);assert.equal(registration[1],'knowledge');assert.equal(registration[2].restricted,true);
  const app=new Application(),root=window.document.createElement('div');app._replaceHTML(null,root);await settle();assert.equal(f.writes,6);
  window.document.body.append(root);app._onRender();await settle();assert(root.querySelector('[data-sky-knowledge-property]'));await app.close();assert.equal(root.children.length,0);
  f.game.user.isGM=false;assert.equal(app._canRender(),false);
});
