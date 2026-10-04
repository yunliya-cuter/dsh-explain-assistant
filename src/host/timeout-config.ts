/**
 * §10：调用限额的**可配置覆盖**（只用于把超时压到几秒，从而能在页面上真实验证 F7）。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────
 * F7「界面超时提示」的实现一直都在（routes.ts 发中文 aborted 事件），但**从没在页面上触发过**：
 * 默认总超时 300s、空闲 120s，靠干等不现实，所以这条一直是「没验证」。
 * 把预算做成可覆盖后，测试与页面验证可以把它压到几秒，真实触发一次超时、看到那句中文提示。
 *
 * ── 安全底线（这是「可配置」最容易出事的地方）──────────────────────
 * 1. **不设配置时行为一丝不变**：回退到 llm.ts 的默认值（300s / 120s）。
 *    本模块**不复制**那两个常量，而是返回 undefined 让 llm.ts 用它自己的默认值 ——
 *    这样默认值只有一个来源，将来改默认值不会出现两处不一致。
 * 2. **校验严格**：非数字、NaN、Infinity、<= 0、超过上限的值一律**回退默认**（即不覆盖）。
 *    绝不能让一次错误配置把超时变成 0（瞬间全部超时）或让它变成永久等待。
 */

/** 环境变量名。刻意带插件前缀，避免与其它组件撞名。 */
export const TIMEOUT_ENV_TOTAL = 'DSH_EXPLAIN_ASSISTANT_TOTAL_TIMEOUT_MS';
export const TIMEOUT_ENV_IDLE = 'DSH_EXPLAIN_ASSISTANT_IDLE_TIMEOUT_MS';

/**
 * 允许配置的上限：1 小时。
 * 超过它就不认为是「有意配置」，按错误配置回退默认（避免有人误填成毫秒以外单位，
 * 例如把「5 分钟」写成 5e12，那等于永久等待，超时保护形同虚设）。
 */
export const MAX_CONFIGURABLE_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * 把环境变量里的一项解析成**合法毫秒数**；不合法返回 undefined（= 不覆盖，用默认）。
 *
 * 判定顺序刻意保守：任何一步不确定就回退，绝不猜。
 */
export function parseTimeoutMs(raw: unknown): number | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;                       // 空字符串 = 没配
  // 只接受纯十进制整数：拒绝 '5e3'、'0x10'、'12px'、'1.5'、'  '、'+5' 等一切含糊写法。
  // （Number('') === 0 这种坑正是「错误配置把超时变成 0」的来源，所以先做字符串形态检查。）
  if (!/^[0-9]+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) return undefined;
  if (value <= 0) return undefined;                     // 0 会让一切都立刻超时
  if (value > MAX_CONFIGURABLE_TIMEOUT_MS) return undefined;  // 过大 ≈ 永久等待，视为误配
  return value;
}

export interface ConfiguredTimeouts {
  totalTimeoutMs?: number;
  idleTimeoutMs?: number;
}

/**
 * 读出配置好的超时预算。
 *
 * @param env 环境变量来源（默认 process.env）；显式传入便于测试，不依赖真实进程环境。
 * @returns 只包含**合法**的项；非法项直接省略，让 llm.ts 用默认值。
 */
export function readConfiguredTimeouts(env: Record<string, unknown> | undefined = (typeof process !== 'undefined' ? process.env : undefined)): ConfiguredTimeouts {
  if (!env) return {};
  const total = parseTimeoutMs(env[TIMEOUT_ENV_TOTAL]);
  const idle = parseTimeoutMs(env[TIMEOUT_ENV_IDLE]);
  return {
    ...(total === undefined ? {} : { totalTimeoutMs: total }),
    ...(idle === undefined ? {} : { idleTimeoutMs: idle }),
  };
}
