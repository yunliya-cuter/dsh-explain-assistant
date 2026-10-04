import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleFromSource, clientVm, fakeDom, FakeElement, sse, streamResponse } from './fixtures/runtime.mjs';
const apiModule=await moduleFromSource('src/client/api.ts');
const client=await moduleFromSource('src/client/index.ts');
const selection=await moduleFromSource('src/client/selection.ts');


const withFetch=async(t,fn)=>{const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});return fn();};
const mockApi=()=>({state:async()=>({payload:{records:[]}}),history:async()=>({payload:{records:[]}}),ask:async()=>{},compact:async()=>{},cancel:async()=>{}});
test('SSE client: chunked UTF8/CRLF events keep full payload and metadata', async t=>withFetch(t,async()=>{
  const events=[]; globalThis.fetch=async()=>streamResponse((sse('start')+sse('text',{delta:'汉字解释'})+sse('complete')).replaceAll('\n','\r\n'));
  await apiModule.createAssistantApi().ask('session-a','问题',undefined,[],e=>events.push(e)); assert.deepEqual(events.map(e=>e.type),['start','text','complete']); assert.equal(events[1].data.delta,'汉字解释'); assert.equal(events[1].envelope.sessionId,'session-a');
}));
test('SSE client: rejects stream that disconnects before terminal', async t=>withFetch(t,async()=>{
  globalThis.fetch=async()=>streamResponse(sse('start')+sse('text',{delta:'partial'})); await assert.rejects(apiModule.createAssistantApi().ask('session-a','问题'),e=>e.code==='SSE_TERMINAL_MISSING');
}));
test('SSE client: cross-session envelope must not be delivered', async t=>withFetch(t,async()=>{
  globalThis.fetch=async()=>streamResponse(sse('text',{delta:'another session'},{sessionId:'other'})+sse('complete',{}, {sessionId:'other'})); const events=[];
  try {await apiModule.createAssistantApi().ask('session-a','问题',undefined,[],e=>events.push(e));}catch{}
  assert.equal(events.length,0,'cross-session event leaked through API callback');
}));
test('compact: only trim exact /compact dispatches, no chat history deletion',async()=>{
 const calls=[];const api={...mockApi(),ask:async(id,q,signal,evidence,emit)=>{calls.push(['ask',q]);emit({type:'complete',data:{},envelope:{}});},compact:async(id,signal,emit)=>{calls.push(['compact']);emit({type:'complete',data:{},envelope:{}});}};const plugin=client.createClientPlugin({api,session:{id:'compact-case'}});try{plugin.registry.update('compact-case',{records:[{id:'old',question:'old',status:'complete',createdAt:'now'}]});await plugin.submit(' /compact ');await plugin.submit('/compact more');await plugin.submit('/COMPACT');assert.deepEqual(calls,[['compact'],['ask','/compact more'],['ask','/COMPACT']]);assert.equal(plugin.registry.get('compact-case').records[0].id,'old');}finally{plugin.dispose();plugin.registry.remove('compact-case');}
});
test('compact: failure retains previous history',async()=>{
 const plugin=client.createClientPlugin({api:{...mockApi(),compact:async()=>{throw Error('model unavailable')}},session:{id:'compact-failure'}});try{plugin.registry.update('compact-failure',{records:[{id:'old',question:'old',status:'complete',createdAt:'now'}]});await plugin.submit('/compact');assert.equal(plugin.registry.get('compact-failure').records[0].id,'old');assert.equal(plugin.registry.get('compact-failure').phase,'error');}finally{plugin.dispose();plugin.registry.remove('compact-failure');}
});
test('client: session switch preserves background signal and independent text',async()=>{
 const requests=[]; const api={...mockApi(),ask:(id,q,signal,evidence,onEvent)=>new Promise(resolve=>requests.push({id,signal,onEvent,resolve}))};const plugin=client.createClientPlugin({api,session:{id:'parallel-a'}});try{const a=plugin.submit('a');plugin.setSession('parallel-b');const b=plugin.submit('b');assert.equal(requests[0].signal.aborted,false);for(const r of requests){r.onEvent({type:'start',data:{requestId:r.id},envelope:{}});r.onEvent({type:'text',data:{delta:r.id},envelope:{}});r.onEvent({type:'complete',data:{},envelope:{}});r.resolve();}await Promise.all([a,b]);assert.equal(plugin.registry.get('parallel-a').text,'parallel-a');assert.equal(plugin.registry.get('parallel-b').text,'parallel-b');}finally{plugin.dispose();plugin.registry.remove('parallel-a');plugin.registry.remove('parallel-b');}
});
test('client: duplicate complete adds only one history record',async()=>{
 const api={...mockApi(),ask:async(id,q,signal,evidence,emit)=>{emit({type:'start',data:{requestId:'r'},envelope:{}});emit({type:'text',data:{delta:'answer'},envelope:{}});emit({type:'complete',data:{},envelope:{}});emit({type:'complete',data:{},envelope:{}});}};const plugin=client.createClientPlugin({api,session:{id:'dedup'}});try{await plugin.submit('q');assert.equal(plugin.registry.get('dedup').records.length,1);}finally{plugin.dispose();plugin.registry.remove('dedup');}
});
test('client VM: entry registers exactly header utility and shell overlay',async()=>{
 const env=await clientVm();try{assert.deepEqual(env.entries.map(e=>e.meta.name),['conversation.session.header.utilities','shell.overlay']);assert.equal(env.entries[0].component({sessionId:'vm-case'}).children[0],'?');}finally{env.cleanup();}
});
test('selection: contextmenu freezes card, excludes helper, Shift+Enter and cleanup',async()=>{
 const dom=fakeDom();try{const chat=new FakeElement();chat.setAttribute('data-chat-root','true');const card=new FakeElement();card.setAttribute('data-tool','read');card.setAttribute('data-state','running');card.textContent='original';chat.append(card);const picked=[];const controller=selection.attachSelection(dom.document,'session-a',v=>picked.push(v));const event=dom.document.emit('contextmenu',{target:card});assert.equal(event.defaultPrevented,true);card.textContent='changed';assert.equal(picked[0].summary,'original');assert.equal(picked[0].incomplete,true);dom.document.activeElement=card;dom.document.emit('keydown',{key:'Enter',shiftKey:true});assert.equal(picked.length,2);chat.className='dsh-explain-assistant-overlay';dom.document.emit('contextmenu',{target:card});assert.equal(picked.length,2);controller.dispose();chat.className='';dom.document.emit('contextmenu',{target:card});assert.equal(picked.length,2);}finally{dom.restore();}
});
test('selection: source frozen and required provenance is not fabricated',()=>{
 const dom=fakeDom();try{const card=new FakeElement();card.setAttribute('data-tool','read');card.textContent='partial';const result=selection.evidenceFromElement(card,'session-a');assert.equal(result.source,'selected_frozen');assert.equal(result.truncated,false);assert.ok('version' in result,'version must be present, or explicitly unavailable');}finally{dom.restore();}
});
test('window: default and small viewports clamp safely',async()=>{
 const windowModule=await moduleFromSource('src/client/window.ts');
 const g=windowModule.clampGeometry(undefined,1024,768);assert.deepEqual(g,{x:588,y:132,width:420,height:620});const small=windowModule.clampGeometry({x:999,y:-10,width:900,height:900},360,400);assert.ok(small.x>=0&&small.y>=0);assert.ok(small.width<=360&&small.height<=400);
});
test('window: pointermove does not persist; pointerup persists and dispose detaches',async()=>{
 const windowModule=await moduleFromSource('src/client/window.ts');
 const dom=fakeDom();try{const root=new FakeElement(),handle=new FakeElement('header'),resize=new FakeElement('button');const changed=[];const control=windowModule.attachWindowInteractions(root,handle,resize,{x:20,y:20,width:420,height:620},g=>changed.push(g));handle.emit('pointerdown',{pointerId:1,button:0,clientX:10,clientY:10});root.emit('pointermove',{pointerId:1,clientX:30,clientY:30});assert.equal(changed.length,0);root.emit('pointerup',{pointerId:1});assert.equal(changed.length,1);assert.equal(changed[0].x,40);control.dispose();assert.equal(handle.listeners.get('pointerdown')?.size,0);}finally{dom.restore();}
});
test('focus: overlay Escape closes and restores entry focus; Tab stays inside',async()=>{
 const overlay=await moduleFromSource('src/client/overlay.tsx');
 const dom=fakeDom();try{const entry=new FakeElement('button');entry.focus();let closed=false;const state={sessionId:'focus-case',phase:'idle',occupancyKnown:false,draft:'',records:[],tools:[],evidence:[],text:'',reasoning:''};const plugin={registry:{close(){closed=true;},update(){}},submit:async()=>{},loadEarlier:async()=>{}};const root=overlay.renderOverlay(state,plugin);await Promise.resolve();assert.equal(dom.document.activeElement.tagName,'TEXTAREA');root.emit('keydown',{key:'Escape'});assert.equal(closed,true);assert.equal(dom.document.activeElement,entry);const last=root.querySelectorAll('button').at(-1);last.focus();const tab=root.emit('keydown',{key:'Tab',shiftKey:false});assert.equal(tab.defaultPrevented,true);assert.notEqual(dom.document.activeElement,last);}finally{dom.restore();}
});
