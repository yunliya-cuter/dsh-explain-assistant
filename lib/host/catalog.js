/**
 * 模型目录发现与选择判定（docs/business-logic.md §7 / §11.8）。
 *
 * 硬要求：小助手的模型与主 agent 分开选择；**未选择模型时必须提示用户去选，
 * 绝不偷偷调用默认模型**。因此本模块在"未选择"时只会返回 required 判定，
 * 不会替调用方挑一个默认值。
 *
 * 本模块不 import 任何 DSH 内部包：llm 服务由调用方注入，便于单测。
 */
import { ExplainAssistantError } from './contracts.js';
/** 所有面向用户的中文文案集中在此，避免散落硬编码。 */
export const CATALOG_MESSAGES = {
    llmMissing: '暂时无法获取模型目录：宿主没有提供模型服务。',
    providersEmpty: '暂时没有可用的模型提供方。',
    providerListFailed: (reason) => '读取模型提供方列表失败：' + reason,
    providerFailed: (provider, reason) => '模型提供方「' + provider + '」读取失败：' + reason,
    providerEmpty: (provider) => '模型提供方「' + provider + '」暂时没有可用模型。',
    selectionRequired: '请先为解释小助手选择一个模型，然后再提问。小助手不会自动替你使用默认模型。',
    catalogUnavailable: '当前没有可用的模型，无法为解释小助手生成回答。请检查模型配置后再试。',
    invalidSelection: '模型选择无效：provider 与 model 都必须是非空字符串。',
};
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function nonEmptyString(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
function reasonOf(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * 宿主 llm 服务的 listProviders/listModels 是异步的，且返回 RemoteResult：
 * `Promise<{ ok: true, value: T } | { ok: false, error: RemoteFailure }>`。
 * 旧代码同步调用且不 await、不解包，拿到的是一个 Promise，Array.isArray(Promise) 为 false，
 * 于是目录永远是空（界面显示"暂时没有可用的模型"）。这里统一 await + 解包：
 * 返回 { ok:true, value } 或 { ok:false, reason }。
 */
async function callLlm(self, fn, ...args) {
    if (typeof fn !== 'function')
        return { ok: false, reason: '宿主方法缺失' };
    let settled;
    try {
        // 关键：必须保持 this 绑定。宿主 llm 是 [Remote] 代理，listProviders 内部要读 this.adapters；
        // 裸调用 service.listProviders() 会让 this 变成 undefined，抛 "reading 'adapters'"。
        settled = await Reflect.apply(fn, self, args);
    }
    catch (error) {
        return { ok: false, reason: reasonOf(error) };
    }
    // RemoteResult 解包：{ ok:false, error } 视为失败；{ ok:true, value } 取 value。
    if (isRecord(settled) && typeof settled.ok === 'boolean') {
        if (settled.ok === true)
            return { ok: true, value: settled.value };
        const err = settled.error;
        const reason = isRecord(err) ? (nonEmptyString(err.message) ?? nonEmptyString(err.code) ?? '远程调用失败') : reasonOf(err);
        return { ok: false, reason };
    }
    // 兼容：有的实现直接返回数组（非 RemoteResult 包装）。
    return { ok: true, value: settled };
}
function normalizeModel(provider, raw) {
    if (!isRecord(raw))
        return undefined;
    const id = nonEmptyString(raw.id) ?? nonEmptyString(raw.model);
    if (!id)
        return undefined;
    const declaredProvider = nonEmptyString(raw.provider) ?? provider;
    const name = nonEmptyString(raw.name) ?? id;
    const modalities = Array.isArray(raw.inputModalities)
        ? raw.inputModalities.filter((item) => typeof item === 'string')
        : undefined;
    const contextWindow = typeof raw.contextWindow === 'number' && Number.isFinite(raw.contextWindow) && raw.contextWindow > 0
        ? raw.contextWindow
        : undefined;
    return {
        provider: declaredProvider,
        id,
        name,
        ...(nonEmptyString(raw.description) ? { description: nonEmptyString(raw.description) } : {}),
        ...(modalities && modalities.length ? { inputModalities: modalities } : {}),
        ...(contextWindow ? { contextWindow } : {}),
    };
}
/**
 * 遍历宿主 llm 服务的 provider，逐个拉取模型目录。
 *
 * 容错原则：单个 provider 失败只记录一条 failures，不能拖垮整体；
 * 整个目录不可用时返回空 groups + failures，而不是抛异常 ——
 * 抛异常会让路由派生错误响应，用户体验是"点了没反应"。
 */
export async function discoverCatalog(llm, signal) {
    const service = isRecord(llm) ? llm : undefined;
    if (!service || typeof service.listProviders !== 'function' || typeof service.listModels !== 'function') {
        return { groups: [], failures: [{ code: 'MODEL_CATALOG_UNAVAILABLE', message: CATALOG_MESSAGES.llmMissing }] };
    }
    const listedProviders = await callLlm(service, service.listProviders);
    if (!listedProviders.ok) {
        return { groups: [], failures: [{ code: 'MODEL_CATALOG_UNAVAILABLE', message: CATALOG_MESSAGES.providerListFailed(listedProviders.reason) }] };
    }
    const providers = Array.isArray(listedProviders.value) ? listedProviders.value : [];
    if (!providers.length) {
        return { groups: [], failures: [{ code: 'MODEL_CATALOG_UNAVAILABLE', message: CATALOG_MESSAGES.providersEmpty }] };
    }
    const groups = [];
    const failures = [];
    for (const entry of providers) {
        signal?.throwIfAborted();
        const providerId = isRecord(entry)
            ? nonEmptyString(entry.id) ?? nonEmptyString(entry.provider)
            : nonEmptyString(entry);
        if (!providerId) {
            failures.push({ code: 'MODEL_CATALOG_UNAVAILABLE', message: CATALOG_MESSAGES.providerFailed('(未命名)', '缺少 provider 标识') });
            continue;
        }
        const listedModels = await callLlm(service, service.listModels, providerId);
        if (!listedModels.ok) {
            failures.push({ code: 'MODEL_CATALOG_PARTIAL', message: CATALOG_MESSAGES.providerFailed(providerId, listedModels.reason) });
            continue;
        }
        const raw = listedModels.value;
        const models = (Array.isArray(raw) ? raw : [])
            .map(item => normalizeModel(providerId, item))
            .filter((item) => item !== undefined);
        // 去重：适配器若返回重复 id，保留第一条，避免 UI 出现重复选项。
        const seen = new Set();
        const unique = models.filter(model => (seen.has(model.id) ? false : (seen.add(model.id), true)));
        if (!unique.length) {
            failures.push({ code: 'MODEL_CATALOG_PARTIAL', message: CATALOG_MESSAGES.providerEmpty(providerId) });
            continue;
        }
        groups.push({
            provider: providerId,
            ...(isRecord(entry) && nonEmptyString(entry.displayName) ? { displayName: nonEmptyString(entry.displayName) } : {}),
            models: unique,
        });
    }
    return { groups, failures };
}
/** 目录里是否至少有一个可选模型。 */
export function catalogHasModels(catalog) {
    return Boolean(catalog && catalog.groups.some(group => group.models.length > 0));
}
/**
 * 判定当前该用哪个模型。
 *
 * 三种结果互斥，且 **未选择时绝不返回任何具体 provider/model** ——
 * 这正是 §11.8「不偷偷调用默认模型」的落点。
 */
export function resolveSelection(explicit, catalog) {
    if (isRecord(explicit)) {
        const provider = nonEmptyString(explicit.provider);
        const model = nonEmptyString(explicit.model);
        if (provider && model) {
            const effort = nonEmptyString(explicit.reasoningEffort);
            return { kind: 'explicit', provider, model, ...(effort ? { reasoningEffort: effort } : {}) };
        }
    }
    if (catalogHasModels(catalog))
        return { kind: 'required', message: CATALOG_MESSAGES.selectionRequired };
    return { kind: 'unavailable', message: CATALOG_MESSAGES.catalogUnavailable };
}
/** 校验并归一化一个用户提交的模型选择；非法输入抛 INVALID_REQUEST。 */
export function toModelSelection(value) {
    const source = isRecord(value) && isRecord(value.model) ? value.model : value;
    if (!isRecord(source))
        throw new ExplainAssistantError('INVALID_REQUEST', CATALOG_MESSAGES.invalidSelection);
    const provider = nonEmptyString(source.provider);
    const model = nonEmptyString(source.model) ?? nonEmptyString(source.id);
    if (!provider || !model)
        throw new ExplainAssistantError('INVALID_REQUEST', CATALOG_MESSAGES.invalidSelection);
    const effort = nonEmptyString(source.reasoningEffort);
    return { provider, model, ...(effort ? { reasoningEffort: effort } : {}) };
}
/** 目录中是否存在这个精确的 provider/model 组合。用于选中后回显校验。 */
export function catalogContains(catalog, provider, model) {
    return Boolean(catalog?.groups.some(group => group.provider === provider && group.models.some(item => item.id === model)));
}
