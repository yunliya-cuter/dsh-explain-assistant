/**
 * UI 可达性/可见性的**源码级**检查工具。
 *
 * 为什么是源码级而不是浏览器实测：Lead 独占 3082 的浏览器会话，本轮不开浏览器。
 * 所以这里从 CSS 文本 + overlay/window 源码里解析出控件的样式与盒模型，再按规则判定。
 *
 * ⚠️ 这是**近似**，不是浏览器布局引擎。诚实边界：
 *   · 只处理 px 值（pt/rem/% 一律记为「不可判定」而不是猜）；
 *   · 文本宽度按「中日韩字符 = 1em、其它 = 0.55em」估算（用于按钮宽度）；
 *   · 不处理 flex 换行、绝对定位的层叠、继承链的完整计算。
 * 但它足以抓住本轮这类缺陷（用户看不出/点不到的控件），且**模型已被已知事实校验**：
 * 用「历史样式」（手柄 18×18、发送按钮无右侧留白）跑一遍，得到的重叠是 **5×6px**，
 * 与 Lead 实测的「约 5×6px」**逐像素一致**（见 ui-affordance.test.mjs 的校验用例）。
 */

/** 去掉注释（注释里的示例声明不能参与判定）。 */
export function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * 极简 CSS 解析：返回 [{ sel, decls }]，**跳过 @ 规则块内部**（媒体查询等本次不判定）。
 */
export function parseCss(css) {
  const text = stripComments(css);
  const rules = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(text))) {
    const sel = m[1].trim().replace(/\s+/g, ' ');
    if (sel.startsWith('@') || !sel) continue;
    const decls = {};
    for (const part of m[2].split(';')) {
      const i = part.indexOf(':');
      if (i <= 0) continue;
      decls[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    // 逗号分组的选择器要**拆成多条**：CSS 里 `.a,.b,.c{width:12px}` 等价于三条独立规则。
    // 不拆的话 declsFor('.b') 取不到值，实测让「八个热区」只解析到 0 个（假红）。
    for (const one of sel.split(',').map(s => s.trim()).filter(Boolean)) {
      rules.push({ sel: one, decls });
    }
  }
  return rules;
}

/**
 * px 解析：认「Npx」，也认**裸 0**（CSS 里 0 不需要单位）。
 * 其它单位（rem/%/pt）返回 undefined —— **不猜**。
 *
 * 裸 0 这条是实测补的：`.ea-resize-n{top:0}` 一开始被判成「不是 px 值」，
 * 于是「边热区必须贴边」那条闸把四个正确的控件全报成不合格。
 * 不修的话闸会制造假红，比漏报更糟（会诱使人去放宽判据）。
 */
export function px(value) {
  const text = String(value ?? '').trim();
  if (text === '0') return 0;
  const m = /^(-?[\d.]+)px$/.exec(text);
  return m ? Number.parseFloat(m[1]) : undefined;
}

/** CSS padding 简写展开 → [top,right,bottom,left]。 */
export function expandPadding(value) {
  const parts = String(value ?? '').trim().split(/\s+/).filter(Boolean).map(px);
  if (!parts.length || parts.some(v => v === undefined)) return undefined;
  if (parts.length === 1) return [parts[0], parts[0], parts[0], parts[0]];
  if (parts.length === 2) return [parts[0], parts[1], parts[0], parts[1]];
  if (parts.length === 3) return [parts[0], parts[1], parts[2], parts[1]];
  return [parts[0], parts[1], parts[2], parts[3]];
}

/** 在规则表里按选择器精确取声明（后出现者覆盖前者，与 CSS 同序）。 */
export function declsFor(rules, selector) {
  const out = {};
  for (const rule of rules) {
    if (rule.sel !== selector) continue;
    Object.assign(out, rule.decls);
  }
  return out;
}

/** 取某个 CSS 值里内嵌的 fallback 颜色（`var(--x,#888)` → '#888'）。 */
export function colorFallback(value) {
  const m = /var\([^,]+,\s*([^)]+)\)/.exec(String(value ?? ''));
  if (m) return m[1].trim();
  return String(value ?? '').trim();
}

/**
 * 最低对比度的颜色集合：本项目把 label-tertiary 用作「最弱」的文字色。
 * 用「解析得到的字面值」比对，不写死某个具体十六进制（CSS 里可能写 #777 / #888 / #8a8a8a）。
 */
export const FAINT_COLORS = new Set(['#777', '#888', '#666', '#8a8a8a', '#999', '#aaa', '#767676', '#6b6b6b']);

/** 估算文本宽度（px）。中日韩 = 1em，其它 = 0.55em。 */
export function textWidth(text, fontSize) {
  let em = 0;
  for (const ch of String(text)) em += /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(ch) ? 1 : 0.55;
  return em * fontSize;
}
