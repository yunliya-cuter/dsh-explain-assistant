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
interface LlmContext {
    llm?: any;
    tokenMeter?: any;
    model: AssistantModel;
    tools?: ToolContext;
    signal?: AbortSignal;
    maxRounds?: number;
    maxTools?: number;
    maxToolBytes?: number;
    totalTimeoutMs?: number;
    idleTimeoutMs?: number; /** false = 这次请求不向模型暴露任何工具（压缩用）。 */
    allowTools?: boolean;
    onEvent?: (event: Record<string, unknown>) => Promise<void> | void;
}
/** 模型调用失败的原因（§10：不能静默失败，也不能把失败说成成功）。 */
interface LlmFailureInfo {
    code: string;
    message: string;
}
interface LlmResult {
    text: string;
    reasoning: string;
    usage?: unknown;
    toolTrace: unknown[];
    complete: boolean; /** true 表示因超时停止（§10/§11.9），上层要给出明确中文提示。 */
    timeout?: boolean; /** true 表示模型输出撞到上限被截断（finish reason=max-tokens）：不算正常完成。 */
    limit?: boolean; /** 非空表示模型调用本身失败，上层必须当错误处理，绝不能说成成功。 */
    failure?: LlmFailureInfo;
}
/**
 * 带超时地跑一次助手请求。
 *
 * 超时不抛异常给上层（上层是 SSE 流，抛出去会变成 error 事件但拿不到已产出的文本），
 * 而是返回 complete:false + 明确原因，由上层按 §10 给出中文提示。
 * **模型调用失败**则不同：那是必须让用户看见的错误，用 failure 字段带回去。
 */
export declare function runAssistant(ctx: LlmContext, messages: AssistantMessage[]): Promise<LlmResult>;
/**
 * §9.1 压缩指令。
 *
 * 2026-11-07：压缩提示词整体搬到 prompts.ts —— 它和「回答用户」的系统提示词是两件事，
 * 混用会造成两种实测故障（摘要复述系统提示词、压缩指令被当成用户的话写进摘要）。
 * 这里只做转发：既有调用方与测试继续从本模块取 COMPACT_INSTRUCTION，行为不变。
 */
export { COMPACT_INSTRUCTION, COMPACT_SECTION_TITLES, COMPACT_SYSTEM_PROMPT } from './prompts.js';
export declare function compactAssistant(ctx: LlmContext, messages: AssistantMessage[]): Promise<{
    summary: string;
    reasoning: string;
    usage?: unknown;
    complete: boolean;
    timeout?: boolean;
    failure?: LlmFailureInfo;
}>;
