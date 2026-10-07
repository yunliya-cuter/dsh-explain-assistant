/**
 * 回答正文的 Markdown 渲染。
 *
 * 用户原话：「没有对 md 的符号进行解析。我希望能够解析的同时还保证性能。」
 * 两件事必须同时成立：**记号要变成格式**，且**流式吐字时不能卡**。
 *
 * ── 为什么不引第三方库 ────────────────────────────────────────────────
 * 主对话界面自己那套渲染器（dsh-client-ui-primitives 的 MarkdownText）确实已经打进
 * 页面里，但它是 React 组件、依赖 react-dom/client；本插件的浮窗是**命令式 DOM**
 * （见 overlay.tsx 的 el()）。更要紧的是：本仓库的测试跑在假 DOM 里，React 树在那儿
 * 根本渲染不出来 —— 复用它等于把「解析对不对」变成只有人眼在页面上才能验的事。
 * 所以自写一层：纯 DOM、零依赖、能在假 DOM 里逐条断言，也能在真页面上跑同一份代码。
 *
 * ── 性能怎么保证 ────────────────────────────────────────────────────
 * 流式回答期间宿主每来一个分片就重画一次（一次回答几十到几百次）。若每次都整篇重新
 * 解析并重建 DOM，代价随长度线性增长、总代价平方级 —— 这就是「越解析越慢」。
 * 这里做三件事：
 *   1. **块级冻结**：已终结的块（后面跟着空行 / 代码围栏已闭合）DOM 只建一次，
 *      之后一直复用同一批节点对象，不再重新解析。每来一个分片只重解析**最后一块**。
 *   2. **代码块增量追加**：正在生长的代码围栏不重写 textContent，只追加新增的那一段。
 *   3. **只替换尾部**：调用方通过 mountMarkdown 把冻结前缀原样留在容器里，只换尾部节点；
 *      冻结部分的 DOM 连挪动都不会发生（否则会打断浏览器的滚动锚定，表现为跳变）。
 *
 * ── 安全 ────────────────────────────────────────────────────────────
 * 全程只用 createElement / textContent，**从不碰 innerHTML**。链接只允许
 * http/https/mailto 变成可点锚点，其他协议（javascript:、data:、file:）一律退回纯文本。
 */
/**
 * 每个位置「下一个未转义的 `]` / `)` 在哪」的预计算表。
 *
 * ── 为什么必须有这张表（用户点名要求「保证性能」）──────────────
 * 朴素写法在找不到闭合符时会**从当前位置一路扫到字符串结尾**。于是：
 *   · 一串没有闭合的 `[`（模型吐出半个链接、或正文里本来就有很多方括号）→ 每个位置都扫到尾部 → O(n²)；
 *   · 深嵌套方括号 → 同上。
 * 实测（修前）：8000 个 `[` 要 150ms、16000 个要 611ms、32000 个要 2624ms ——
 * 而 8000 字普通中文只要 2ms。4 倍输入、17 倍耗时，是明确的平方级。
 * 这不只是「慢」：流式期间每来一个分片就要重解析一次，卡住的是整个页面。
 *
 * 修法：整段扫描**一次**，把每个下标对应的「下一个闭合符位置」先算出来（O(n) 时间、O(n) 空间），
 * 之后每次探测都是查表 O(1)。转义符（反斜杠）在预计算时就已经排除。
 *
 * 表只在缺少闭合符时用于**快速否定**：查到「这里根本没有下一个 ]」就直接返回 undefined，
 * 不再扫。有限的层数仍由下面的 depth 上限与 depth>=8 的截断兜住。
 */
type CloseIndex = {
    bracket: Int32Array;
    paren: Int32Array;
};
/**
 * 把一段行内文本渲染成节点数组。
 * depth 是防御性的深度上限：异常深层嵌套不该把页面拖死。
 */
export declare function renderInlineNodes(src: string, depth?: number, index?: CloseIndex): Node[];
export type MarkdownBlock = {
    type: 'paragraph' | 'heading' | 'code' | 'list' | 'quote' | 'hr' | 'table';
    start: number;
    end: number;
    /** 已经被确定终结（后面跟着空行，或代码围栏已闭合）。只有终结的块才允许冻结。 */
    closed: boolean;
    level?: number;
    text?: string;
    info?: string;
    ordered?: boolean;
    /** 有序列表的起始号（CommonMark 的 <ol start>）。仅当不是 1 时才需要写进 DOM。 */
    startNumber?: number;
    items?: {
        text: string;
    }[];
    /** 表格表头单元格（已按未转义竖线切开、已 trim）。 */
    header?: string[];
    /** 表格每列对齐（GFM 的 :--- / :---: / ---:）。null = 默认左对齐。 */
    align?: (string | null)[];
    /** 表格正文行；短行在渲染时补空、长行丢弃，保证列不错位。 */
    rows?: string[][];
};
/** 把 src[from..) 扫成块。调用方负责把已冻结的前缀排除在外。 */
export declare function scanBlocks(src: string, from?: number): MarkdownBlock[];
/** 一次性渲染（已定稿的文本）。 */
export declare function renderMarkdownNodes(text: string): Node[];
export type MarkdownStats = {
    /** 被真正解析并建过 DOM 的块数（冻结后不再增长）。 */
    blockRenders: number;
    /** render() 被调用的次数。 */
    calls: number;
    /** 因文本未变而整次跳过的次数。 */
    skips: number;
    /** 代码块走「只追加增量」的次数。 */
    codeAppends: number;
    /**
     * 真正写进 DOM 的字符数。
     *
     * 为什么需要这个而不是只看 codeAppends：次数只说明「走了哪个分支」，
     * 不说明「干了多少活」——把追加换回整段重写，次数照样涨，测试却不会红（本项目实测过一次）。
     * 字符数则直接反映工作量：增量追加下它 ≈ 文本总长；整段重写下它 ≈ 每次分片长度的累加，
     * 也就是平方级。这条指标改坏了必红。
     */
    codeChars: number;
};
export type MarkdownRenderer = {
    render(text: string, streaming: boolean): Node[];
    /** 返回序列中前多少个节点是「已冻结、不会再变」的。 */
    readonly frozenCount: number;
    readonly stats: MarkdownStats;
    reset(): void;
};
/**
 * 增量渲染器。
 *
 * 不变量：frozen 里的节点一旦产生就不再重新解析、不再替换；
 * 每次 render 只重算 frozen.length 之后的那一段（最多两三个块）。
 */
export declare function createMarkdownRenderer(): MarkdownRenderer;
export declare function cachedMarkdownNodes(key: string, text: string): Node[];
export declare function settledCacheSize(): number;
/** 缓存层真正解析过多少次（命中缓存时不应增长）。 */
export declare function settledCacheParseCount(): number;
export declare function clearSettledCache(): void;
export type MarkdownView = {
    /** 更新到最新文本。streaming=true 表示还在吐字。 */
    update(text: string, streaming: boolean): void;
    /**
     * 容器里前多少个节点属于「已冻结、不会再变」的前缀。
     *
     * 暴露它的理由：这是增量渲染**唯一的对外契约**。没有它，调用方（和测试）
     * 就只能猜「哪些节点是稳定的」——早期一个测试就是这么写的，把「刚渲染出来的
     * 最后一块」也当成稳定块来断言，于是必然失败。契约要能被读到，才谈得上被守住。
     */
    readonly frozenCount: number;
    readonly stats: MarkdownStats;
    dispose(): void;
};
/**
 * 把增量渲染挂到一个容器上。
 *
 * 关键点：**只删尾部、只加尾部**，已冻结的节点始终留在容器里原地不动。
 * 若改成每次 replaceChildren(全部节点)，冻结节点会被「摘下来再挂回去」——
 * 元素虽然还是同一个对象，但浏览器会因此丢掉滚动锚点，用户看到的就是跳变。
 */
export declare function mountMarkdown(container: Element): MarkdownView;
export {};
