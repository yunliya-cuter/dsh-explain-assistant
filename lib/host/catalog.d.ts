/**
 * 模型目录发现与选择判定（docs/business-logic.md §7 / §11.8）。
 *
 * 硬要求：小助手的模型与主 agent 分开选择；**未选择模型时必须提示用户去选，
 * 绝不偷偷调用默认模型**。因此本模块在"未选择"时只会返回 required 判定，
 * 不会替调用方挑一个默认值。
 *
 * 本模块不 import 任何 DSH 内部包：llm 服务由调用方注入，便于单测。
 */
import { type ModelSelection } from './contracts.js';
type CatalogModel = {
    provider: string;
    id: string;
    name: string;
    description?: string;
    inputModalities?: readonly string[];
    contextWindow?: number;
};
type CatalogGroup = {
    provider: string;
    displayName?: string;
    models: CatalogModel[];
};
type CatalogFailure = {
    code: string;
    message: string;
};
type Catalog = {
    groups: CatalogGroup[];
    failures: CatalogFailure[];
};
type SelectionResolution = {
    kind: 'explicit';
    provider: string;
    model: string;
    reasoningEffort?: string;
} | {
    kind: 'required';
    message: string;
} | {
    kind: 'unavailable';
    message: string;
};
/**
 * 遍历宿主 llm 服务的 provider，逐个拉取模型目录。
 *
 * 容错原则：单个 provider 失败只记录一条 failures，不能拖垮整体；
 * 整个目录不可用时返回空 groups + failures，而不是抛异常 ——
 * 抛异常会让路由派生错误响应，用户体验是"点了没反应"。
 */
export declare function discoverCatalog(llm: unknown, signal?: AbortSignal): Promise<Catalog>;
/**
 * 把一次**整体失败**包成目录形状：空 groups + 一条中文 failures。
 *
 * ⚠️ 存在的唯一理由就是**不要**再写 `.catch(() => ({ groups: [], failures: [] }))`。
 * 那种兜底把「目录读取失败」与「目录真的是空的」变成同一个形状，
 * 而客户端只能靠这两个数组区分二者（见 overlay.tsx 的 catalogUnavailable）——
 * 于是 /state 仍然 200、stateError 为 undefined、界面判为 ready，
 * 显示「还没有选择模型 / 共 0 个可选 / 还没有小助手历史 / 占用未知」且不说一句「没读到」。
 * 这正是用户点名要消掉的那类**会被读成结论**的文案。
 */
export declare function catalogReadFailure(error: unknown): Catalog;
/**
 * 判定当前该用哪个模型。
 *
 * 三种结果互斥，且 **未选择时绝不返回任何具体 provider/model** ——
 * 这正是 §11.8「不偷偷调用默认模型」的落点。
 */
export declare function resolveSelection(explicit: unknown, catalog: Catalog | undefined): SelectionResolution;
/** 校验并归一化一个用户提交的模型选择；非法输入抛 INVALID_REQUEST。 */
export declare function toModelSelection(value: unknown): ModelSelection;
/** 目录中是否存在这个精确的 provider/model 组合。用于选中后回显校验。 */
export declare function catalogContains(catalog: Catalog | undefined, provider: string, model: string): boolean;
export {};
