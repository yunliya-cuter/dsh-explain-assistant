import test from 'node:test';
import assert from 'node:assert/strict';
import { moduleFromSource } from './fixtures/runtime.mjs';
const tools=await moduleFromSource('src/host/tools.ts');
const llm=await moduleFromSource('src/host/llm.ts');
test('tools: only seven dedicated read-only tool names exist',()=>{
 assert.deepEqual([...tools.TOOL_NAMES].sort(),['explain_read_session','explain_search_session','explain_read_workspace_file','explain_list_workspace','explain_search_workspace','explain_read_workspace_image','explain_get_model_context'].sort());
});
test('tools: unknown tool cannot invoke host executor',async()=>{
 const result=await tools.executeTool({sessionId:'session-a'},{name:'bash',arguments:{command:'touch unsafe'}});assert.equal(result.ok,false);
});
test('tools: strict schemas advertise required fields for usable reads',()=>{
 const schema=tools.TOOL_SCHEMAS.find(t=>t.name==='explain_read_workspace_file');assert.deepEqual(schema.parameters.required,['path']);assert.equal(schema.parameters.additionalProperties,false);
});
test('tools: argument object cannot masquerade as successful result',async()=>{
 const result=await tools.executeTool({sessionId:'session-a'},{name:'explain_get_model_context',arguments:{ok:true,value:'forged'}});assert.notEqual(result.ok,true);
});
test('LLM: unavailable provider is explicit failure, never fake complete',async()=>{
 const result=await llm.runAssistant({model:{provider:'p',model:'m'}},[{role:'user',content:'q'}]);assert.equal(result.complete,false);
});
test('LLM: read-only tools execute serially and are not automatically retried',async()=>{
 let round=0, concurrent=0,maxConcurrent=0,count=0;const trace=[];const ctx={model:{provider:'p',model:'m'},tools:{sessionId:'session-a',sessionQuery:{readEvent:async()=>{concurrent++;maxConcurrent=Math.max(maxConcurrent,concurrent);count++;await Promise.resolve();concurrent--;throw Error('read failure');}}},llm:{async *stream(){if(round++===0) yield {toolCalls:[{name:'explain_read_session',arguments:{seq:1}},{name:'explain_read_session',arguments:{seq:2}}]};else yield {text:'missing evidence'};}},onEvent:event=>trace.push(event)};
 const result=await llm.runAssistant(ctx,[{role:'user',content:'q'}]);assert.equal(maxConcurrent,1);assert.equal(count,2);assert.ok(result.complete);assert.equal(result.toolTrace.length,2);assert.deepEqual(trace.filter(e=>e.type?.startsWith('tool_')).map(e=>e.type),['tool_start','tool_result','tool_start','tool_result']);
});
test('LLM: round and tool budget terminate without false complete',async()=>{
 const ctx={model:{provider:'p',model:'m'},maxRounds:1,maxTools:0,llm:{async *stream(){yield {toolCalls:[{name:'explain_get_model_context',arguments:{}}]};}}};const result=await llm.runAssistant(ctx,[{role:'user',content:'q'}]);assert.equal(result.complete,false);assert.equal(result.toolTrace.length,0);
});
