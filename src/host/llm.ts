import { executeTool, TOOL_SCHEMAS, type ToolContext, type ToolResult } from './tools.js';

export interface AssistantModel { provider:string; model:string; reasoningEffort?:string; contextWindow?:number; inputModalities?:readonly string[]; }
export interface AssistantMessage { role:'system'|'user'|'assistant'|'tool'; content:unknown; id?:string; toolCallId?:string; isError?:boolean; source?:unknown; }
export interface LlmContext { llm?:any; tokenMeter?:any; model:AssistantModel; tools?:ToolContext; signal?:AbortSignal; maxRounds?:number; maxTools?:number; maxToolBytes?:number; totalTimeoutMs?:number; idleTimeoutMs?:number; onEvent?:(event:Record<string,unknown>)=>Promise<void>|void; }
/** 模型调用失败的原因（§10：不能静默失败，也不能把失败说成成功）。 */
export interface LlmFailureInfo { code:string; message:string; }
export interface LlmResult { text:string; reasoning:string; usage?:unknown; toolTrace:unknown[]; complete:boolean; /** true 表示因超时停止（§10/§11.9），上层要给出明确中文提示。 */ timeout?:boolean; /** 非空表示模型调用本身失败，上层必须当错误处理，绝不能说成成功。 */ failure?:LlmFailureInfo; }
const DEFAULTS={maxRounds:8,maxTools:32,maxToolBytes:512*1024,totalTimeoutMs:300_000,idleTimeoutMs:120_000};
/**
 * §10 / §11.9「出现慢、失败或费用不可控信号时…不无限调用追求效果」。
 *
 * 旧实现全程**没有任何超时**：模型不返回就永远挂着，用户界面停在「正在解释…」，
 * 既没有提示也不能恢复（上一轮实测里 /compact 在 0.1.23 上就是这样挂到 220 秒无变化）。
 * 这里加两个上限，都是「到点就停并如实说明」，不是静默失败：
 * - totalTimeoutMs：整次请求（含工具循环）的总上限；
 * - idleTimeoutMs：两次产出之间的空转上限，专门抓「连上了但模型一直不吐字」。
 */
const TIMEOUT_MARKER = 'TIMEOUT';

/** 一次流式响应的解析结果。字段名与 dsh-llm 的 StreamChunk 协议对齐。 */
export type ParsedChunk = {
  text?: string;
  reasoning?: string;
  /** 已组装完成的工具调用（真实协议里由 block-end 或 tool-call-delta 累积得到）。 */
  toolCalls?: { id?: string; name?: string; arguments?: unknown }[];
  usage?: unknown;
  done?: boolean;
  /** §10：适配器把故障归一化成 finish(reason.kind='error')，必须当失败处理。 */
  failure?: LlmFailureInfo;
};

/**
 * 解析一个流式分片。
 *
 * 这里必须同时认识 **dsh-llm 的真实 StreamChunk 协议** 与历史遗留的简化形状，
 * 因为旧实现只认识了后者，于是真实运行时发生的事一件都看不见：
 *
 * 1. 真实协议用 block-start / text-delta / reasoning-delta / tool-call-delta / block-end
 *    表达内容。旧实现只读 `chunk.text`/`chunk.delta.text`，文本恰好能读到（text-delta 带 text 字段），
 *    但**工具调用完全读不到** —— 真实协议的工具参数在 argumentsDelta 里，旧实现只找 chunk.toolCalls，
 *    所以工具循环在真实运行时永远不触发，等于 7 个只读工具形同不存在。
 * 2. 更严重：真实协议用 finish(reason.kind) 表达终止。适配器抛出的故障（参数不合法、
 *    消息形状不合契约、鉴权失败…）会被 LlmRuntime **归一化成**
 *    finish reason.kind='error' 的终止分片，而旧实现把 finish 当成普通结束，
 *    于是「模型一个字都没说 + complete:true」被当成成功返回 —— 用户看到空白答案，
 *    界面显示成功。本轮实测就是这样：同一会话追问第二次，108 个文本分片变成 0 个，
 *    却报 complete:true。这类静默失败必须显式暴露。
 */
export function parseChunk(chunk:any):ParsedChunk{
  if(!chunk||typeof chunk!=='object')return {};
  const type=chunk.type;
  if(type==='finish'){
    const kind=chunk.reason?.kind;
    if(kind==='error')return {done:true,failure:{code:String(chunk.reason?.failure?.code??'LLM_FAILED'),message:String(chunk.reason?.failure?.message??'模型调用失败')}};
    if(kind==='aborted')return {done:true,failure:{code:'ABORTED',message:String(chunk.reason?.failure?.message??'模型调用已中断')}};
    return {done:true};
  }
  if(type==='text-delta')return {text:typeof chunk.text==='string'?chunk.text:undefined};
  if(type==='reasoning-delta')return {reasoning:typeof chunk.text==='string'?chunk.text:undefined};
  if(type==='usage')return {usage:chunk.usage};
  // block-start / block-end / tool-call-delta 由调用方按索引累积，这里给出增量信息。
  if(type==='tool-call-delta')return {toolCalls:[{id:chunk.id,name:chunk.name,argumentsDelta:chunk.argumentsDelta}] as any};
  if(type==='block-end'&&chunk.block?.type==='tool-call')return {toolCalls:[{id:chunk.block.id,name:chunk.block.name,arguments:chunk.block.arguments}]};
  // 兼容历史简化形状（旧测试与自定义 stream 用）。
  const text=chunk.text ?? chunk.delta?.text;
  const reasoning=chunk.reasoning ?? chunk.delta?.reasoning;
  const calls=chunk.toolCalls ?? chunk.tool_calls;
  return {text:typeof text==='string'?text:undefined,reasoning:typeof reasoning==='string'?reasoning:undefined,toolCalls:Array.isArray(calls)?calls:undefined,usage:chunk.usage,done:chunk.done===true};
}

/** 把模型给出的工具参数归一成对象。真实协议里 arguments 是**原始 JSON 字符串**。 */
export function toolArguments(value:unknown):Record<string,unknown>{
  if(typeof value==='string'){try{const parsed=JSON.parse(value);return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed:{}}catch{return {}}}
  return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
}
async function emit(ctx:LlmContext,event:Record<string,unknown>):Promise<void>{await ctx.onEvent?.(event);}
/**
 * 带超时地跑一次助手请求。
 *
 * 超时不抛异常给上层（上层是 SSE 流，抛出去会变成 error 事件但拿不到已产出的文本），
 * 而是返回 complete:false + 明确原因，由上层按 §10 给出中文提示。
 * **模型调用失败**则不同：那是必须让用户看见的错误，用 failure 字段带回去。
 */
export async function runAssistant(ctx:LlmContext,messages:AssistantMessage[]):Promise<LlmResult>{
 const total=ctx.totalTimeoutMs??DEFAULTS.totalTimeoutMs,idle=ctx.idleTimeoutMs??DEFAULTS.idleTimeoutMs;
 const controller=new AbortController();
 const parent=ctx.signal;
 // 用户点「停止」必须**立刻**返回，不能等总超时到点。
 // 只 abort controller 不够：底层 stream 若不响应 signal，for await 会一直挂着。
 const abortByParent=()=>{aborted=true;controller.abort();rejectRace?.(new Error(TIMEOUT_MARKER+': aborted'));};
 if(parent?.aborted)abortByParent();else parent?.addEventListener('abort',abortByParent,{once:true});
 let timedOut=false,aborted=false,totalTimer:any,rejectRace:(reason:Error)=>void;
 // 用一个可主动拒绝的 promise 作为 race 的另一条腿：空闲超时与总超时都走它。
 // 只 abort controller 是不够的——底层 stream 若不响应 signal，for await 会永远挂着，
 // inner 不 settle，race 也就永远不返回（实测：空闲超时被总超时抢先，说明正是这个原因）。
 const armed=new Promise<never>((_,reject)=>{rejectRace=reject;});
 totalTimer=setTimeout(()=>{timedOut=true;controller.abort();rejectRace(new Error(TIMEOUT_MARKER+': total'));},total);
 if(typeof totalTimer?.unref==='function')totalTimer.unref();
 try{
   return await Promise.race([
     runAssistantInner({...ctx,signal:controller.signal},messages,idle,()=>{timedOut=true;controller.abort();rejectRace(new Error(TIMEOUT_MARKER+': idle'));}),
     armed,
   ]);
 }catch(error){
   const message=error instanceof Error?error.message:'';
   // 父信号中断是用户主动停止：抛出 ABORTED，由上层按「已中断」处理（不冒充超时）。
   if(aborted&&!timedOut)throw Object.assign(new Error('已按你的要求停止'), {code:'ABORTED'});
   // 只有我们自己的超时才吞掉，转成 complete:false + timeout 标志。
   if(timedOut&&!parent?.aborted)return {text:'',reasoning:'',toolTrace:[],complete:false,timeout:true};
   if(message.startsWith(TIMEOUT_MARKER)&&!parent?.aborted)return {text:'',reasoning:'',toolTrace:[],complete:false,timeout:true};
   throw error;
 }finally{clearTimeout(totalTimer);parent?.removeEventListener('abort',abortByParent);}
}
async function runAssistantInner(ctx:LlmContext,messages:AssistantMessage[],idleMs:number,onIdle:()=>void):Promise<LlmResult>{
 if(!ctx.llm?.stream) return {text:'',reasoning:'',toolTrace:[],complete:false,failure:{code:'MODEL_UNAVAILABLE',message:'宿主没有提供模型服务，无法生成解释。'}};
 // 没有 provider/model 就不可能选到适配器路由，与其静默返回空回答让用户以为"助手没反应"，
 // 不如显式标记失败，由上层给出中文原因。
 if(!ctx.model?.provider || !ctx.model?.model) return {text:'',reasoning:'',toolTrace:[],complete:false,failure:{code:'MODEL_UNAVAILABLE',message:'这个主对话还没有选择模型，无法生成解释。'}};
 const maxRounds=ctx.maxRounds??DEFAULTS.maxRounds,maxTools=ctx.maxTools??DEFAULTS.maxTools,maxBytes=ctx.maxToolBytes??DEFAULTS.maxToolBytes; let text='',reasoning='',usage:any,toolCount=0,toolBytes=0; const trace:any[]=[]; let history=[...messages];
 for(let round=0;round<maxRounds;round++){
  // dsh-llm 的 stream 需要**顶层** provider 与 model 两个字段来选适配器路由：
  // 只传 { model: {...} } 会让 registration(options.provider) 拿不到 provider，
  // 结果是流直接结束、返回空文本（表现为「点了发送没反应」）。
  const stream=ctx.llm.stream({provider:ctx.model?.provider, model:ctx.model?.model, messages:history, tools:TOOL_SCHEMAS}, {signal:ctx.signal}); const calls:any[]=[];
  // §10 空闲超时：连上了但一直不吐字，不能无限等。每收到一个 chunk 就重置计时。
  let idleTimer:any,failure:LlmFailureInfo|undefined;
  const resetIdle=()=>{clearTimeout(idleTimer); idleTimer=setTimeout(()=>{onIdle();},idleMs); if(typeof idleTimer?.unref==='function')idleTimer.unref();};
  resetIdle();
  try{
   for await(const raw of stream){
    ctx.signal?.throwIfAborted(); resetIdle();
    const c=parseChunk(raw);
    if(c.failure){failure=c.failure;break;}
    if(c.text){text+=c.text;await emit(ctx,{type:'text',delta:c.text});}
    if(c.reasoning){reasoning+=c.reasoning;await emit(ctx,{type:'reasoning',delta:c.reasoning});}
    if(c.usage){usage=c.usage;await emit(ctx,{type:'usage',usage});}
    if(c.toolCalls){
     // tool-call-delta 分片累积；block-end 给出的完整调用若已存在则用它覆盖。
     for(const call of c.toolCalls){
      const delta=(call as any).argumentsDelta;
      if(delta!==undefined){
       const key=call.id??('idx-'+calls.length);
       let existing=calls.find(item=>item.id===key&&item.streaming);
       if(!existing){existing={id:call.id,name:call.name,raw:'',streaming:true};calls.push(existing);}
       if(call.name)existing.name=call.name;
       existing.raw+=String(delta);
      }else{
       const existing=call.id?calls.find(item=>item.id===call.id&&item.streaming):undefined;
       if(existing){existing.raw=undefined;existing.streaming=false;existing.name=call.name??existing.name;existing.arguments=call.arguments;}
       else calls.push({id:call.id,name:call.name,arguments:call.arguments});
      }
     }
    }
   }
  }finally{clearTimeout(idleTimer);}
  if(failure)return {text,reasoning,usage,toolTrace:trace,complete:false,failure};
  // §10：适配器故障被归一化成 finish(error) 时，绝不能当作「正常结束、只是没说话」。
  const normalized=calls.map(call=>({id:call.id,name:call.name,arguments:toolArguments(call.arguments??call.raw)}));
  if(!normalized.length) return {text,reasoning,usage,toolTrace:trace,complete:true};
  if(toolCount+normalized.length>maxTools)return {text,reasoning,usage,toolTrace:trace,complete:false};
  // 工具循环要让模型看见**自己发起的那次调用**，否则下一轮请求里工具结果找不到对应调用。
  // dsh-llm 的 ToolResultMessage 契约要求顶层 toolCallId + content: ContentBlock[]，
  // 且适配器会用 assistant 消息里的 tool-call 块校验 tool_use_id 是否配对
  // （dsh-llm-deepseek: "tool result has no matching call"）。
  // 旧实现的 tool 消息只有 { role, content }，既没有 toolCallId 也没有配对的 assistant 消息，
  // 于是任何一次真实工具调用都会让第二轮请求失败——而失败又被静默吞掉。
  // callId 只能生成**一次**并在两处复用：assistant 的 tool-call 块与 tool 结果消息必须配对，
  // 否则适配器会以 "tool result has no matching call" 拒绝整个请求。
  // （旧写法在两处各自兜底生成了不同的 id，模型不给 id 时立刻对不上。）
  const callIds=normalized.map((call,index)=>String(call.id??('ea-call-'+round+'-'+index)));
  history.push({
   role:'assistant', id:'assistant-'+round,
   content:normalized.map((call,index)=>({type:'tool-call',id:callIds[index],name:String(call.name??''),arguments:JSON.stringify(call.arguments??{})})),
   source:{kind:'model',provider:ctx.model.provider,model:ctx.model.model},
  });
  for(const [index,call] of normalized.entries()){
   toolCount++; const callId=callIds[index]; const name=call.name;
   await emit(ctx,{type:'tool_start',tool:name,callId});
   const result:ToolResult=await executeTool(ctx.tools??{sessionId:''}, {name,arguments:call.arguments});
   const serialized=JSON.stringify(result); toolBytes+=Buffer.byteLength(serialized);
   const exceeded=toolBytes>maxBytes;
   const bounded=exceeded?{ok:false,code:'TOOL_BUDGET_EXCEEDED',message:'工具结果累计太大，已经停止，以免把小助手的上下文塞满。',retryable:false}:result;
   trace.push({tool:name,callId,arguments:call.arguments,status:bounded.ok?'ok':'error',result:bounded,startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),truncated:exceeded,sentBytes:Buffer.byteLength(JSON.stringify(bounded)),availableBytes:Buffer.byteLength(serialized)});
   await emit(ctx,{type:'tool_result',tool:name,callId,result:bounded});
   // content 必须是内容块数组；ToolResultMessage 要求 role/source/toolCallId/content 齐备。
   history.push({role:'tool',id:'tool-'+toolCount,toolCallId:callId,isError:bounded.ok!==true,source:{kind:'tool',callId},content:[{type:'text',text:JSON.stringify(bounded)}]});
   if(exceeded)return {text,reasoning,usage,toolTrace:trace,complete:false};
  }
 }
 return {text,reasoning,usage,toolTrace:trace,complete:false};
}
/** §9.1 压缩指令：中文，且必须保留限制性标注，不得因压缩丢失不确定性。 */
export const COMPACT_INSTRUCTION = [
 '请把上面这段「解释小助手」的上下文压缩成一份简短的中文摘要。要求：',
 '1. 用白话中文写，不要用英文，不要用行话。',
 '2. 必须保留每条依据的分级（已观察到 / 仅据汇报 / 无从得知）。',
 '3. 必须原样保留「该步未提供足够信息」这类限制性标注，不得因为压缩而把不确定说成确定。',
 '4. 保留用户已经问过什么、结论是什么。',
 '5. 只压缩小助手自己与用户的对话。**主 agent 的上下文不在你要压缩的范围里**：',
 '   你不需要、也不得为它写任何摘要，更不要把它当成小助手说过的话。',
 '6. 不要改动主对话的任何内容。',
].join('\n');
export async function compactAssistant(ctx:LlmContext,messages:AssistantMessage[]):Promise<{summary:string;reasoning:string;usage?:unknown;complete:boolean;timeout?:boolean;failure?:LlmFailureInfo}>{
 // content 必须是内容块数组：dsh-llm 的适配器会执行 message.content.flatMap(...)，
 // 传字符串会在适配器里抛错，压缩请求根本发不出去。
 const result=await runAssistant(ctx,[...messages,{role:'user',content:[{type:'text',text:COMPACT_INSTRUCTION}]}]);
 return {summary:result.text,reasoning:result.reasoning,usage:result.usage,complete:result.complete,...(result.timeout===undefined?{}:{timeout:result.timeout}),...(result.failure===undefined?{}:{failure:result.failure})};
}
