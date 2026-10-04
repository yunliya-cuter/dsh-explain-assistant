import { type ToolContext } from './tools.js';
export interface AssistantModel {
    provider: string;
    model: string;
    reasoningEffort?: string;
    contextWindow?: number;
    inputModalities?: readonly string[];
}
export interface AssistantMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: unknown;
    id?: string;
    toolCallId?: string;
    isError?: boolean;
    source?: unknown;
}
export interface LlmContext {
    llm?: any;
    tokenMeter?: any;
    model: AssistantModel;
    tools?: ToolContext;
    signal?: AbortSignal;
    maxRounds?: number;
    maxTools?: number;
    maxToolBytes?: number;
    totalTimeoutMs?: number;
    idleTimeoutMs?: number;
    onEvent?: (event: Record<string, unknown>) => Promise<void> | void;
}
/** 模型调用失败的原因（§10：不能静默失败，也不能把失败说成成功）。 */
export interface LlmFailureInfo {
    code: string;
    message: string;
}
export interface LlmResult {
    text: string;
    reasoning: string;
    usage?: unknown;
    toolTrace: unknown[];
    complete: boolean; /** true 表示因超时停止（§10/§11.9），上层要给出明确中文提示。 */
    timeout?: boolean; /** 非空表示模型调用本身失败，上层必须当错误处理，绝不能说成成功。 */
    failure?: LlmFailureInfo;
}
/** 一次流式响应的解析结果。字段名与 dsh-llm 的 StreamChunk 协议对齐。 */
export type ParsedChunk = {
    text?: string;
    reasoning?: string;
    /** 已组装完成的工具调用（真实协议里由 block-end 或 tool-call-delta 累积得到）。 */
    toolCalls?: {
        id?: string;
        name?: string;
        arguments?: unknown;
    }[];
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
export declare function parseChunk(chunk: any): ParsedChunk;
/** 把模型给出的工具参数归一成对象。真实协议里 arguments 是**原始 JSON 字符串**。 */
export declare function toolArguments(value: unknown): Record<string, unknown>;
/**
 * 带超时地跑一次助手请求。
 *
 * 超时不抛异常给上层（上层是 SSE 流，抛出去会变成 error 事件但拿不到已产出的文本），
 * 而是返回 complete:false + 明确原因，由上层按 §10 给出中文提示。
 * **模型调用失败**则不同：那是必须让用户看见的错误，用 failure 字段带回去。
 */
export declare function runAssistant(ctx: LlmContext, messages: AssistantMessage[]): Promise<LlmResult>;
/** §9.1 压缩指令：中文，且必须保留限制性标注，不得因压缩丢失不确定性。 */
export declare const COMPACT_INSTRUCTION: string;
export declare function compactAssistant(ctx: LlmContext, messages: AssistantMessage[]): Promise<{
    summary: string;
    reasoning: string;
    usage?: unknown;
    complete: boolean;
    timeout?: boolean;
    failure?: LlmFailureInfo;
}>;
