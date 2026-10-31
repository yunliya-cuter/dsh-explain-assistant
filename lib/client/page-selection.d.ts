/**
 * 正文选区的动画高亮（移植自 More 设置向导 2026-10-25 版 page-selection.js）。
 *
 * 浏览器原生的 ::selection 只能"啪"地出现、啪地换形，没有任何过渡可言。
 * 这里在浮窗上叠一层高亮块：位置与宽度由弹簧驱动（键盘 0.2s / 拖选 0.1s /
 * 淡入 0.12s，与输入框里那套同源），跨行、跨段的选区会被平滑地重塑。
 *
 * 三条硬约束：
 *  1. 只画在**文字下方**：高亮层 z-index:-1，浮窗是层叠上下文，
 *     于是它排在浮窗背景之上、所有内容之下 —— 字形一个像素都不会被染色/变粗。
 *  2. 只量文字：整段 Range 直接取矩形会把图标、按钮也量成方块，
 *     所以按文本节点切开，各取各的矩形，再按几何去重（嵌套矩形会叠出深色）。
 *  3. 不拦操作：整层 pointer-events:none，拖选、双击选词、Ctrl+A、复制都不受影响。
 *
 * ── 本轮修正（2026-10-31 审计）─────────────────────────────────
 * · **画不了就交还原生**。自绘高亮有三个画不了的场景，以前都是"硬画一半"，
 *   而原生选中色又被关掉了，结果就是"选中了却什么都看不见"：
 *     a) 选区里有不透明底色（模型页/教程页/提问气泡/引导卡/错误卡）——
 *        高亮垫在 z-index:-1，被那些底色整个盖住；
 *     b) 选区超过 MAX_BLOCKS 个矩形 —— 以前只画前 24 个，
 *        实测 37 行的选区只有 20 行有蓝色，剩下 17 行看着像没选中；
 *     c) 选区落在浮窗里但量不出任何文字矩形（例如在输入框里）。
 *   这三种情况现在统一把 data-page-selection 摘掉，让浏览器原生选中色回来：
 *   宁可没有动画，也不能让"选中"这件事看不出来。
 * · **跨出浮窗边界的选区**：以前只要 range 的公共祖先跑出浮窗（拖到浮窗外），
 *   整段 range 直接被丢弃，浮窗内那一段高亮整体消失。现在按"是否与浮窗相交"判断，
 *   只画落在浮窗里的那部分。
 * · **减少动态效果可以在运行中切换**：监听 media query 的 change，
 *   两个方向都要切回对应的那一套（否则 CSS 把自绘层 display:none 了，原生又是透明的）。
 *
 * 输入框里的选区不在这里画 —— 那是 text-field.ts 的活，两边各管一段，不会叠成两份。
 */
import { type TextFieldConfig } from './text-field.js';
export type PageSelectionHandle = {
    readonly layer: HTMLElement;
    refresh(): void;
    destroy(): void;
};
export declare function mountPageSelection(root: HTMLElement, overrides?: Partial<TextFieldConfig>): PageSelectionHandle;
