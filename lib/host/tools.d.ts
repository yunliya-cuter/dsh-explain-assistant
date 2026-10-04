export type ToolName = 'explain_read_session' | 'explain_search_session' | 'explain_read_workspace_file' | 'explain_list_workspace' | 'explain_search_workspace' | 'explain_read_workspace_image' | 'explain_get_model_context';
export interface ToolError {
    ok: false;
    code: string;
    message: string;
    retryable: boolean;
    details?: Record<string, unknown>;
}
export interface ToolSuccess<T = unknown> {
    ok: true;
    value: T;
    truncated?: boolean;
    availableBytes?: number;
    sentBytes?: number;
}
export type ToolResult<T = unknown> = ToolSuccess<T> | ToolError;
export interface ToolContext {
    sessionId: string;
    workspace?: string;
    imageSnapshotRoot?: string;
    signal?: AbortSignal;
    sessionQuery?: any;
    attachmentStore?: any;
    modelContext?: unknown;
    limits?: Partial<ToolLimits>;
}
export interface ToolCall {
    name: string;
    arguments?: unknown;
    callId?: string;
}
export interface ToolLimits {
    maxRounds: number;
    maxCalls: number;
    maxTotalResultBytes: number;
    maxSingleResultBytes: number;
    toolTimeoutMs: number;
    totalTimeoutMs: number;
}
export declare const DEFAULT_TOOL_LIMITS: ToolLimits;
export declare const TOOL_NAMES: readonly ToolName[];
export declare const TOOL_SCHEMAS: {
    name: ToolName;
    description: string;
    parameters: {
        type: string;
        properties: Record<string, unknown>;
        required: readonly string[] | undefined;
        additionalProperties: boolean;
    };
}[];
export declare function executeTool(ctx: ToolContext, call: ToolCall): Promise<ToolResult>;
export interface ToolLoopResult {
    calls: number;
    rounds: number;
    totalBytes: number;
    results: Array<{
        call: ToolCall;
        result: ToolResult;
    }>;
    stopped?: ToolError;
}
export declare function executeToolLoop(ctx: ToolContext, calls: readonly ToolCall[], options?: Partial<ToolLimits>): Promise<ToolLoopResult>;
