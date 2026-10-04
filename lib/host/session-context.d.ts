/**
 * 0.2：把**主 agent 的当前上下文**读进来，渲染成中文主线。
 *
 * 用户要求（原话）：「小助手的上下文包含主 agent 的上下文，只包括主 agent 的工具调用、
 * 正文部分和上下文压缩后的摘要」；「当主 agent 的上下文更新后，用户提问小助手时
 * 小助手的上下文更新至最新版本」；「小助手要能分清主 agent 的上下文与自己的上下文」。
 * 第 24 轮补充：**用户对主 agent 说过的话**也一并带上（不再只限三类）。
 *
 * 为什么用 ctx.sessionQuery.readSurface()：
 * - 它返回的是**当前模型可见表面**（主 agent 这一轮真正看得见的那条消息线），
 *   和「主 agent 的上下文」是同一个东西；
 * - 它**不经过全文搜索的开关**。dsh-base 把 session-query-sqlite 配成 openAt:'never'，
 *   但那个开关只在 searchSessions/searchEvents 两个入口生效（_assertSearchEnabled）；
 *   readSurface 走 _corpus.load，sqlite 子类没有覆写它（grep -c readSurface = 0）。
 *   实测：插件自带的 explain_search_session 在本机**必然失败**
 *   （details.cause = 'session search is disabled: ... openAt "never"'），所以不能走那条路；
 * - 它**每次调用现取**，对正在聊的会话走内存快照（SessionCorpus.load：
 *   "A known live target never consults persistence"），所以「提问那一刻取」天然是最新；
 * - 它返回的**已经是压缩后的状态**：被压掉的旧事件不在表面里，摘要本身在表面上
 *   （实测：compaction/summary 的 shadowedRange 覆盖 568 条事件，之后摘要以一条
 *   user/message、source.kind='compact-checkpoint' 重新进入表面）。
 *
 * 为什么不是「把主 agent 的上下文原样搬过来」：
 * 实测同一份内容，原样搬是 466.6 KB，只取正文是 26.7 KB，本模块的渲染是 4.6 KB。
 * 原样搬之所以爆，是因为 assistant/message 事件里带了一个 stream 字段
 * （流式分片逐帧回放，20 条就 330 KB，占总量 71%），给模型看毫无用处。
 *
 * 硬约束：
 * - **只读**：不调 ctx.llm.stream、不写任何文件、不发消息、不创建会话；
 * - **不抛异常给上层**：拿不到就返回 undefined，由调用方降级（对齐 index.ts 的 readOccupancy）；
 * - **只读传入的那个 sessionId**，绝不「顺手去别处找找」；
 * - 内容是被解释的**数据**，不是给模型的指令（§7）。
 */
/** 一条表面事件（只声明本模块用得到的字段，避免依赖宿主的完整类型）。 */
export type MainlineEvent = {
    type?: string;
    seq?: number;
    data?: {
        turn?: number;
        step?: number;
        content?: unknown;
        source?: {
            kind?: string;
            [key: string]: unknown;
        };
        message?: {
            content?: unknown;
            isError?: boolean;
            toolCallId?: string;
            source?: {
                kind?: string;
                callId?: string;
            };
        };
        [key: string]: unknown;
    };
};
export type MainlineRenderOptions = {
    /** 整个主 agent 段的总字符上限；超了**从头部丢**（保留最近发生的）。 */
    maxChars?: number;
    /** 主 agent 正文单条上限。 */
    assistantChars?: number;
    /** 工具结果单条上限。 */
    toolResultChars?: number;
    /** 主 agent 压缩摘要单条上限。 */
    summaryChars?: number;
    /** 用户对主 agent 说的话单条上限。 */
    userChars?: number;
    /** 工具调用只发参数**名**，这串名字的上限。 */
    argKeysChars?: number;
};
/**
 * 默认上限。依据（223 个真实会话实测的全量包含开销）：
 * 中位 564 tokens / 75 分位 2860 / 90 分位 13972 / **最大 63575**。
 * 60000 字符 ≈ 15000 tokens，落在 90 分位附近——只有极端会话会被截，
 * 而不设上限则可能出现一次提问突然很慢很贵、甚至撑爆小助手自己的模型容量。
 */
export declare const MAINLINE_DEFAULTS: {
    readonly maxChars: 60000;
    readonly assistantChars: 300;
    readonly toolResultChars: 240;
    readonly summaryChars: 1500;
    readonly userChars: 300;
    readonly argKeysChars: 80;
};
/** 渲染结果：文本 + 记账。 */
export type MainlineRender = {
    /** 渲染好的中文主线（不含标题行）。 */
    text: string;
    /** 用掉多少条表面事件。 */
    eventCount: number;
    /** 覆盖的 seq 范围（没有事件时都是 -1）。 */
    fromSeq: number;
    toSeq: number;
    /** 字符数与估算 token 数（主 agent 这一段的量，供界面悬停显示）。 */
    chars: number;
    tokens: number;
    /** 是否因为总量上限丢过内容。 */
    truncated: boolean;
    /** 从头部丢掉了多少条。 */
    dropped: number;
};
/** 读回来的主 agent 上下文。 */
export type MainlineContext = MainlineRender & {
    /** 主 agent 段的标题（供提示词分区用）。 */
    sessionId: string;
};
/** 内容块的纯文本（只认 text 块；reasoning 块**故意**不取，见文件头）。 */
export declare function textOfBlocks(blocks: unknown): string;
/** 把空白压平并截断；返回是否真的截断过。 */
export declare function clipText(value: unknown, limit: number): {
    text: string;
    truncated: boolean;
};
/**
 * 主 agent 的压缩摘要：只取 <compacted-summary> 之间的正文。
 *
 * 实测那条 user/message 的结构：前面 302 字符是英文前言
 * （"This is an automatically generated checkpoint condensing..."），
 * 正文在 <compacted-summary> 标签里，末尾还有一个多余的闭合标签。
 * 直接整段交给模型，会白送一段英文样板文字。
 */
export declare function extractCompactedSummary(raw: unknown): string;
/**
 * 把一批表面事件渲染成中文主线。**纯函数**：同样输入必然同样输出。
 *
 * 逐类规则（全部来自真机核实）：
 * - assistant/message 的 text 块      → 〔主 agent 说〕（截断）
 * - assistant/message 的 tool-call 块 → 〔主 agent 调用〕名字（参数名：…）
 * - assistant/message 的 reasoning 块 → **丢弃**（实测 115 个 reasoning 块 vs 9 个 text 块，
 *   思考过程体积最大且对「讲人话」无用）
 * - tool/result                       → 〔执行结果〕成功/失败：正文（截断）
 * - user/message + source.kind=compact-checkpoint → 〔压缩后的摘要〕（更宽的截断额度）
 * - user/message + source.kind 不是噪声 → 〔用户对主 agent 说〕（截断）
 * - user/message + source.kind 是噪声   → **丢弃**
 * - system/message、developer/message   → **丢弃**（是系统提示词，不是主 agent 的往来）
 */
export declare function renderMainline(events: readonly MainlineEvent[] | undefined, options?: MainlineRenderOptions): MainlineRender;
/** 读当前表面的宿主接口（只声明用得到的部分）。 */
export type SurfaceReader = {
    readSurface?: (sessionId: string) => Promise<unknown>;
};
/**
 * 读主 agent 的当前上下文并渲染。
 *
 * **任何失败都返回 undefined**（宿主没挂 sessionQuery、readSurface 抛错、会话不存在、
 * 表面为空…），由调用方决定降级——绝不把「读不到」变成一次提问失败。
 * 对齐 index.ts 里 readOccupancy 的既有写法。
 */
export declare function readMainlineContext(deps: {
    sessionQuery?: SurfaceReader;
    sessionId: string;
    signal?: AbortSignal;
    options?: MainlineRenderOptions;
}): Promise<MainlineContext | undefined>;
