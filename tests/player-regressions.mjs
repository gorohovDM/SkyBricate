import test from 'node:test';
import assert from 'node:assert/strict';
import { playerFixture } from './helpers/player-fixture.mjs';
import { playerRows } from '../scripts/player-panel.js';

const setup = t => {const f=playerFixture();t.after(()=>f.destroy());return f;};
const absent = root => {for(const secret of ['secretid','SealedName','SealedDescription'])assert(!root.outerHTML.includes(secret),secret);};
const search = (f,query) => {const input=f.root.querySelector('input');input.value=query;input.dispatchEvent(new f.window.Event('input'));};
const system = (f,id) => {const select=f.root.querySelector('select');select.value=id;select.dispatchEvent(new f.window.Event('change'));};

test('player projection contains only public component text, known properties and anonymous slots',()=>{
  const f=playerFixture();try{const rows=playerRows(f.snapshot,'a',new Map(f.corpus[0].components.map(c=>[c.id,c])),'actor',true);
    const json=JSON.stringify(rows);for(const secret of ['secretid','SealedName','SealedDescription'])assert(!json.includes(secret));
    assert.equal(rows[0].ordinary[1],null);assert.equal(rows[1].ordinary[0],null);
  }finally{f.destroy();}
});

test('player DOM uses neutral unknown slots, safe known text, no secret IDs/attributes and no writes',t=>{
  const f=setup(t);f.mount();absent(f.root);assert.match(f.root.textContent,/Known <img>/);assert.equal(f.root.querySelector('img'),null);
  assert.equal(f.root.querySelectorAll('li').length,4);assert.equal(f.root.querySelectorAll('li span').length,2);
  assert.equal(f.root.querySelectorAll('button').length,1);assert.equal(f.writes,0);
});

test('player search indexes public component and known name/description only',t=>{
  const f=setup(t);f.mount();
  for(const term of ['SealedName','SealedDescription','secretid','Special description-absent']){search(f,term);assert.equal(f.root.querySelectorAll('article').length,0);absent(f.root);}
  search(f,'healing');assert.equal(f.root.querySelectorAll('article').length,1);
  search(f,'STONE');assert.equal(f.root.querySelectorAll('article').length,1);assert.doesNotMatch(f.root.textContent,/Known <img>/);
  search(f,'Known special');assert.equal(f.root.querySelectorAll('article').length,1);
  search(f,'');assert.equal(f.root.querySelectorAll('article').length,2);
});

test('stock context actor remount and system changes discard old known text and search',t=>{
  const f=setup(t),cleanup=f.mount();system(f,'b');assert.doesNotMatch(f.root.textContent,/Known <img>|Known special/);
  system(f,'a');assert.match(f.root.textContent,/Known <img>/);search(f,'healing');
  const oldInput=f.root.querySelector('input');cleanup();const second=f.mount('other');assert.doesNotMatch(f.root.textContent,/Known <img>|Known special/);
  assert.equal(f.root.querySelector('input').value,'');oldInput.dispatchEvent(new f.window.Event('input'));absent(f.root);second();
  assert.equal(f.root.children.length,0);assert.equal(f.hooks.count('updateActor'),0);
});

test('null, deleted, inaccessible and permission-lost actor never reuse knowledge or GM selection',t=>{
  const f=setup(t);for(const actorId of [null,'missing']){f.mount(actorId);assert.match(f.root.textContent,/NoActor/);assert.equal(f.root.querySelectorAll('article').length,0);}
  f.actors.get('actor').isOwner=false;f.actors.get('actor').testUserPermission=(_user,level)=>{assert.equal(level,'OWNER');return false;};
  f.mount();assert.match(f.root.textContent,/NoActor/);f.actors.get('actor').isOwner=true;f.hooks.fire('updateActor',{id:'actor'});assert.match(f.root.textContent,/Known <img>/);
  f.actors.delete('actor');f.hooks.fire('deleteActor',{id:'actor'});assert.match(f.root.textContent,/NoActor/);assert.doesNotMatch(f.root.textContent,/Known <img>/);
});

test('known special setting toggle removes DOM and search content while preserving bytes',t=>{
  const f=setup(t);f.mount();const before=f.snapshot;f.special=false;assert.doesNotMatch(f.root.textContent,/Known special|Special description/);
  search(f,'Special description');assert.equal(f.root.querySelectorAll('article').length,0);f.special=true;assert.equal(f.root.querySelectorAll('article').length,1);
  assert.deepEqual(f.snapshot,before);assert.equal(f.writes,0);
});

test('open player panel reacts to data onChange, Fabricate setting hooks, refresh and permission changes',t=>{
  const f=setup(t);f.mount();let next=f.snapshot;next.knowledge.actor.a.c=[];f.replace(next);f.notify();assert.doesNotMatch(f.root.textContent,/Known <img>|Known special/);
  next=f.snapshot;next.knowledge.actor.a.c=['p'];f.replace(next);f.root.querySelector('button').click();assert.match(f.root.textContent,/Known <img>/);
  f.corpus[0].components=[];f.hooks.fire('updateSetting',{key:'fabricate.craftingSystems'});assert.match(f.root.textContent,/NoComponents/);
  f.corpus.splice(0,1);f.hooks.fire('updateSetting',{key:'fabricate.craftingSystems'});assert.equal(f.root.querySelector('select').value,'b');assert.doesNotMatch(f.root.textContent,/Known <img>/);
  f.actors.get('actor').isOwner=false;f.hooks.fire('updateUser',{id:'user'});assert.match(f.root.textContent,/NoActor/);assert.equal(f.writes,0);
});

test('empty, corrupt and incompatible player data clears previous content without exposing errors or writing',t=>{
  const f=setup(t);f.mount();const good=f.snapshot;
  for(const bad of [{schemaVersion:99,secret:'SealedName'}, {...good,knowledge:{actor:{a:{c:['secretid','missing']}}}}]){
    f.replace(bad);f.notify();assert.match(f.root.textContent,/Unavailable/);absent(f.root);assert.equal(f.root.querySelectorAll('article').length,0);
  }
  f.replace({schemaVersion:2,systems:{}});f.notify();assert.match(f.root.textContent,/NoProperties/);assert.equal(f.writes,0);
  f.game.modules.get('fabricate').version='future';f.notify();assert.match(f.root.textContent,/Unavailable/);
  f.game.modules.get('fabricate').version='1.9.10';f.corpus.length=0;f.notify();assert.match(f.root.textContent,/NoSystems/);
  f.corpus.push({id:'broken'});f.notify();assert.match(f.root.textContent,/Unavailable/);assert.equal(f.writes,0);
});

test('provider repeated mount, unmount and unregister remove all listeners and detached controls',t=>{
  const f=setup(t);const old=f.mount(),input=f.root.querySelector('input');f.mount('other');old();assert.equal(f.hooks.count('updateActor'),1);
  const contents=f.root.innerHTML;input.value='healing';input.dispatchEvent(new f.window.Event('input'));assert.equal(f.root.innerHTML,contents);
  f.dispose();f.dispose();assert.equal(f.unregisters,1);assert.equal(f.root.children.length,0);
  for(const event of ['updateSetting','updateActor','deleteActor','updateUser'])assert.equal(f.hooks.count(event),0);
  f.notify();f.special=false;assert.equal(f.root.children.length,0);assert.equal(f.writes,0);
});

test('provider validates stock v1 mount surface, tab and context before subscribing',t=>{
  const f=setup(t);for(const context of [null,{}, {...f.context('actor'),surface:'manager'},{...f.context('actor'),schemaVersion:2}]){
    assert.equal(f.provider.mount({target:f.root,tabId:'properties',context}),undefined);assert.equal(f.root.children.length,0);assert.equal(f.hooks.count('updateActor'),0);
  }
});
