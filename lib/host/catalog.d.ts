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
/** 所有面向用户的中文文案集中在此，避免散落硬编码。 */
export declare const CATALOG_MESSAGES: {
    readonly llmMissing: '暂时无法获取模型目录：宿主没有提供模型服务。';
    readonly providersEmpty: '暂时没有可用的模型提供方。';
    readonly providerListFailed: (reason: string) => string;
    readonly providerFailed: (provider: string, reason: string) => string;
    readonly providerEmpty: (provider: string) => string;
    readonly selectionRequired: '请先为解释小助手选择一个模型，然后再提问。小助手不会自动替你使用默认模型。';
    readonly catalogUnavailable: '当前没有可用的模型，无法为解释小助手生成回答。请检查模型配置后再试。';
    readonly invalidSelection: '模型选择无效：provider 与 model 都必须是非空字符串。';
};
export type CatalogModel = {
    provider: string;
    id: string;
    name: string;
    description?: string;
    inputModalities?: readonly string[];
    contextWindow?: number;
};
export type CatalogGroup = {
    provider: string;
    displayName?: string;
    models: CatalogModel[];
};
export type CatalogFailure = {
    code: string;
    message: string;
};
export type Catalog = {
    groups: CatalogGroup[];
    failures: CatalogFailure[];
};
export type SelectionResolution = {
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
/** 目录里是否至少有一个可选模型。 */
export declare function catalogHasModels(catalog: Catalog | undefined): boolean;
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
