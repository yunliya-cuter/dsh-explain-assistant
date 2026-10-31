# UI 层审计（audit-overlay）

- 仓库：/mnt/d/projects/dsh-explain-assistant（v0.3.0 工作区现状）
- 审查范围：src/client/overlay.tsx（3317 行）、src/client/styles.css（1478 行）、src/client/text-field.ts、src/client/page-selection.ts；为确认生命周期旁读了 entry.ts、window.ts、markdown.ts。
- 方式：只读源码 + 只读 Node/fixture 复现；未修改 src/、tests/、lib/、package.json，未 build，未重启 3081/3082，未使用 git。
- 结论：未发现 P0。以下按「真 bug / 反直觉 / 设计取舍 / 存疑」分开列出；每条都给出代码位置和验证入口。
- 说明：3081 需要登录 token，本次没有在真实页面上操作；涉及浏览器排版/输入法/剪贴板的结论均以代码路径和可复现的 fake DOM 为依据，已在对应条目注明「需实测」或「存疑」。

## A. 真 bug

### A-01 自动跟随会在用户上滚时把滚动位置重新拽回底部
- 类型：真 bug
- 严重度：P1
- 位置：src/client/overlay.tsx:2255-2268、2939-2946
- 现象：流式回答进行中，用户用滚轮或拖动滚动条往上读，画面约一帧后又被拉回底部；用户无法在生成过程中自由阅读上面内容。
- 触发路径：在 3081 提一个会产生长回答的问题；回答开始流式输出后，用滚轮向上滚 3-5 格，保持 1 秒。只要回答还在持续增长，视野会反复回到底部。
- 证据：跟随循环每帧先写程序化滚动，再在 160ms 内把随后的所有 scroll 事件都当成「自己滚的」：
    2939  if (delta > 0.05) {
    2944    ctx.followPos += move
    2945    ctx.programmaticScrollAt = Date.now()
    2946    body.scrollTop = ctx.followPos
    ...
    2263  if (current.programmaticScrollAt && Date.now() - current.programmaticScrollAt < 160) return
  用户滚动的 scroll 事件正好落在这个 160ms 窗口内，因此 2265-2268 的 followPaused=true 永远没有机会执行；下一帧 2946 又把 scrollTop 写回底部。只读 fake DOM 复现：内容增长后程序滚到 730.54px；模拟用户滚到 100px 后，下一帧被写回 797.05px。
- 判定理由：用户手动滚动是最高优先级；「程序自己写的滚动」和「用户写的滚动」必须用事件源或一次性 flag 区分，不能用固定 160ms 时间窗覆盖所有事件。这不是可接受的设计取舍，因为它直接违反「用户上滚就停止跟随」的产品判据。
- 修复代价：小（overlay.tsx 单文件：改成写前设一次性 programmatic 标志、scroll 事件里清掉；或忽略带 isTrusted 的用户事件，不用时间窗）。
- 波及：流式跟随、用户滚动、问题气泡到达顶部时的暂停、关闭/切换会话；不能因此让程序滚动被误判成用户滚动。
- 用户自测：3081 提长问题，在流式输出期间用滚轮上滚；视野应停在用户滚到的位置，而不是自动回到底部。当前会回到底部。

### A-02 教程页和模型页可以同时打开，关闭其中一个后留下幽灵 modelOpen 状态
- 类型：真 bug
- 严重度：P1
- 位置：src/client/overlay.tsx:666-683、1198-1235；src/client/styles.css:464、1312-1313
- 现象：打开「使用教程」后再点标题栏「模型」，两个整页面板同时存在；教程页盖在模型页上面，但焦点被送去模型页的筛选框（在不可见层后面）。关闭教程后，data-view 变成 chat，但 modelOpen 仍是 true，下一次 Esc 会关掉一个看不见的模型页，而不是关窗。
- 触发路径：3081 打开浮窗 → 点标题栏「?」打开教程 → 不关教程，直接点标题栏「模型」→ 观察两层页面同时存在；再点教程里的「返回对话」→ 按 Esc。
- 证据：两个 open 函数只设置自己的状态，不处理另一个：
    666  function openModelPanel(ctx: OverlayContext): void {
    ...
    676    ctx.modelOpen = true
    679    ctx.root.setAttribute('data-view', 'model')
    ...
    1198 function openTutorial(ctx: OverlayContext): void {
    ...
    1205    ctx.tutorialOpen = true
    1209    ctx.root.setAttribute('data-view', 'tutorial')
  两个 slot 又都是 z-index:3：
    styles.css:464  .ea-model-panel-slot{...;z-index:3;...}
    styles.css:1312 .ea-tutorial-panel-slot{position:absolute;inset:0;z-index:3;...}
  只读 fake DOM 复现：打开教程再打开模型后，data-view=model，但 .ea-model-panel 和 .ea-tutorial-panel 同时存在，两个触发按钮的 aria-expanded 都是 true；关闭教程后 .ea-model-panel 仍存在、model 按钮 aria-expanded 仍为 true，activeElement 落在 input。
- 判定理由：两个「整页」是互斥视图，不能同时存在；当前有三个状态真相（data-view、modelOpen/tutorialOpen、DOM 面板是否存在），没有单一状态机，必然留下幽灵状态。
- 修复代价：小（openModelPanel 里 closeTutorial(ctx,{focus:false,animate:false})，openTutorial 同理；close 函数不要无条件写 data-view=chat，应按当前仍打开的页面决定）。
- 波及：页面切换动画、焦点恢复、Esc 关闭顺序、标题栏 aria-expanded；必须保留「关闭动画播完再摘节点」。
- 用户自测：按上述路径操作；任何时候屏幕上只应看到一层整页，关闭教程后按 Esc 应先关窗，不应关一个看不见的模型页。

### A-03 历史签名只看 id/status/回答长度，reasoning、incomplete、工具/依据/图片变化不会重画
- 类型：真 bug
- 严重度：P1
- 位置：src/client/overlay.tsx:2724-2733；相关渲染 src/client/overlay.tsx:1486-1517、1491-1493、1579-1581；src/client/overlay.tsx:2601-2612
- 现象：同一条记录在 /state 刷新或宿主补数据后新增了 tools/evidence/images、incomplete/reason 或 reasoning，页面仍保持旧内容；「查看完整内容」按钮、未完成警告、推理过程可能永远不出现。回答正文同长度但内容被替换时也不会更新。
- 触发路径：在 3081 让 /state 先返回一条只有问答的记录；稍后让宿主为同 id 增加 tools/evidence 或把 incomplete/reason 填上（或模拟一次同长度回答替换）；浮窗重画后查看历史这一轮。
- 证据：签名只拼 id、status、answer length：
    2733  state.records.filter(isAskRecord).map(record => recordIdOf(record) + ':' + String(record.status || '') + ':' + recordAnswerText(record).length).join(',')
  但渲染还依赖：
    1491  const incomplete = record.incomplete === true || status === 'interrupted' || ...
    1493  const warnText = incomplete ? ...
    1513  if (reasoning) { ... cachedMarkdownNodes(...reasoning) ... }
    1579  const hasMaterial = recordMaterialCount(record) > 0;
    1580  if (id && hasMaterial ... ) foot.push(button('查看完整内容', ...))
  只读 fake DOM 复现：初始记录 id=r1/status=complete/answer 长度 10；第二次状态同一 id/status/长度，但加 incomplete:true、reason:'cancelled'、tools:[...]；updateOverlay 后 .ea-turn 文本完全不变，警告和「查看完整内容」都没有出现。
- 判定理由：签名是缓存失效的唯一依据，不能只包含「长度」这种近似值；任何影响 historyTurnNodes 输出的字段都必须进入签名，或改为内容指纹/版本号。当前还会扫描全部 records（不是只扫 win.items），在大历史里每次流式更新都做 O(total) 字符串拼接，存在过度重建/性能风险。
- 修复代价：中（overlay.tsx：把 reasoning 长度/内容指纹、incomplete/reason、material 计数、question 纳入签名；最好只扫 win.items；并为历史详情签名补同样的内容指纹）。
- 波及：历史窗口、流式重画、折叠展开、完整内容面板、工具/依据展示；不能把正常流式分片变成整段历史重挂。
- 用户自测：构造或让宿主回填同一条记录的 tools/incomplete/reasoning；重画后这些内容应立即出现。可在 fake DOM 用两条同 id/status/长度但不同 tools 的 state 连续 updateOverlay 验证。

### A-04 输入框镜像用 offsetWidth，长草稿出现滚动条或浮窗改宽后，光标/蓝色选区会偏移
- 类型：真 bug
- 严重度：P1
- 位置：src/client/text-field.ts:167-180、317-328；src/client/overlay.tsx:3278-3279
- 现象：草稿超过约 150px 高度出现纵向滚动条后，自绘光标比实际插入点偏右约一个滚动条宽度；换行点也与 textarea 不一致。拖动浮窗边缘改宽后，镜像宽度没有重算，后续光标/选区仍按旧换行位置绘制。
- 触发路径：3081 在输入框粘贴 20 行以上文本（出现滚动条），把光标点到某行末尾；再拖动浮窗右边改宽 100px，观察光标与选区。
- 证据：镜面宽度取的是包含滚动条的 offsetWidth：
    169  mirror.style.width = input.offsetWidth + 'px'
  而 textarea 有滚动条时，内容可用宽度是 clientWidth - padding，不是 offsetWidth - padding；镜像没有滚动条，于是换行点偏宽。更新入口只有 input/keyup/mouseup/scroll/focus/blur/composition/window resize：
    317-328  listeners = [input input/keyup/mouseup/scroll/focus/blur/composition..., document selectionchange, window resize]
  没有 ResizeObserver 监听 input 或浮窗 root。浮窗改宽由 window.ts 的 pointermove 直接改 style，不会触发 window.resize；所以镜像和选区盒子继续使用旧宽度。
- 判定理由：caret 和选区几何必须与 textarea 的 content box 完全同宽；offsetWidth 与 clientWidth 的口径差异是确定性错误，不是字体或抗锯齿误差。浮窗可拖动改宽是该插件的核心交互，必须有输入框尺寸变化的重算路径。
- 修复代价：中（text-field.ts：改用 clientWidth 或减去滚动条宽度；加 ResizeObserver 观察 input/root；overlay resize 回调里调用 field.refresh；补 document.fonts.ready 刷新）。
- 波及：平滑光标、输入框内选区、换行/emoji/中文光标、窗口缩放；不能把 textarea 的原生滚动或 resize 手感改坏。
- 用户自测：长草稿出现滚动条后，在行末点击，光标应贴住字符末尾；拖动浮窗宽度后，光标应重新贴合实际文字。当前会偏移。

### A-05 浅色主题多项小字号文字对比度低于 4.5:1；深色主题部分错误红也不足
- 类型：真 bug / 无障碍
- 严重度：P1
- 位置：src/client/styles.css:331、612、841、557、605、1296、358、1389；背景 src/client/styles.css:464、1288
- 现象：浅色主题下，次要/三级文字、占位符、模型警告和「仅据汇报」标签发灰或发黄，正常距离阅读吃力；深色主题下工具状态错误红在浮窗玻璃上也偏暗。
- 触发路径：3081 浅色主题 → 打开模型选择页（看「还没有选择模型」的黄色提示与 provider 失败文字）→ 查看依据分级的「仅据汇报」→ 输入框占位符；再切深色主题查看工具过程失败状态。
- 证据：按宿主 dsh-client-ui-theme 的实际 token（light: primary #0f1115、secondary #61666b、tertiary #81858c、error #ec1313、warn #f59e0b；dark: primary #f9fafb、secondary #cfd3d6、tertiary #adb2b8、error #f25a5a、warn #f59e0b），再按 styles.css 的玻璃 alpha 合成背景计算 WCAG 2.x：
    light glass #fbfbfd：secondary 5.61:1 通过；tertiary 3.59:1 失败
    light field #fdfdfe：placeholder（tertiary）3.65:1 失败
    light model pane #fafafc：warn（模型未选提示 / provider 失败）2.06:1 失败
    light tier tinted #faf2e5：warn（仅据汇报）1.93:1 失败
    light glass：error（工具状态）4.35:1 失败；white 卡片上的 .ea-error 4.50:1 刚好通过
    dark glass #32343a：tertiary 5.83:1 通过；error（工具状态）3.78:1 失败；dark card #232324 上的 .ea-error 4.77:1 通过
  以上文字都是 11–12.5px，不属于 WCAG 的 large text，阈值应为 4.5:1。
- 判定理由：这是实际 token 和实际背景 alpha 的组合，不是只在「宿主变量缺失」时的 fallback；错误/警告/占位符承担状态和操作提示，低对比度会让用户漏看，属于可读性缺陷。
- 修复代价：小（调整 tertiary/warn/error 的浅色 token 或对应背景；深色单独验证；不要只改 fallback，要覆盖宿主变量）。
- 波及：浅色/深色两套、模型页、依据分级、工具状态、错误条、输入框占位符；不要为了对比度牺牲品牌色一致性。
- 用户自测：浅色主题打开模型页，看「还没有选择模型」和 provider 失败文字是否明显偏淡；用 DevTools 取 #f59e0b 与 #fafafc 计算应约为 2.06:1。深色主题查看工具失败红色，应约为 3.78:1。

### A-06 运行中切换「减少动态效果」后，输入框光标和正文选区会消失
- 类型：真 bug
- 严重度：P2
- 位置：src/client/text-field.ts:163-165、338-341；src/client/page-selection.ts:74、234-237；src/client/styles.css:793-795、796-799、819
- 现象：先在不启用减少动态的情况下打开浮窗，再在系统设置里开启「减少动态效果」；自绘光标/选区被媒体查询设为 display:none，但 textarea 的 caret-color 和原生 ::selection 仍是 transparent，输入框里看不到光标，正文里看不到选区。
- 触发路径：3081 保持浮窗打开 → 聚焦输入框并选中一段文字 → 在系统辅助功能里打开 reduce motion（不刷新页面）→ 回到浮窗。
- 证据：active 只在 mount 时采样一次：
    163  let active = !prefersReducedMotion() && ...
  没有 matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', ...)。CSS 在 reduce 下隐藏自绘层：
    796-798  .ea-field-caret{display:none} .ea-page-sel{display:none}
    793-795  .ea-field[data-smooth="on"] .ea-input{caret-color:transparent} ...::selection{background:transparent}
    819  [data-page-selection="on"] ::selection{background:transparent}
  但 data-smooth/data-page-selection 仍留在 DOM 上，原生光标/选区继续透明。
- 判定理由：reduce motion 是可在运行中改变的系统偏好；当前代码只在初始化时读取，导致「两层都隐藏」而不是退回原生。
- 修复代价：小到中（text-field/page-selection 各加 matchMedia change 监听：reduce 时 destroy 或清 data 属性；恢复时重新 mount；注意只清自己那套，别误删另一套）。
- 波及：输入框、正文选区、光标闪烁、动画；要保证 reduce 下仍至少有原生光标/选区。
- 用户自测：浮窗打开时切换系统 reduce motion，输入框光标仍应可见（原生或自绘之一），正文选区仍应有蓝色/系统高亮。

### A-07 正文选区层 z-index:-1 会被模型页、教程页、错误卡等不透明背景盖住
- 类型：真 bug
- 严重度：P2
- 位置：src/client/page-selection.ts:64-67；src/client/styles.css:805-819、464、1312-1313、1288、357-363、1174
- 现象：在模型选择页/教程页里拖选文字，或选中错误卡、离线卡片、已选标签里的文字时，看不到蓝色高亮；文字其实被选中了，但看起来像没选中。
- 触发路径：3081 打开模型页 → 拖选一个模型 id；或打开教程页拖选正文；或选中错误卡中的一段文字。
- 证据：高亮层是 root 的负 z-index 子层：
    806  .ea-page-sel-layer{position:absolute;inset:0;z-index:-1;...}
  但模型页/教程页的 slot 有不透明背景且 z-index:3：
    464  .ea-model-panel-slot{...;z-index:3;...background:var(--ea-glass-pane...)}
    1312-1313 .ea-tutorial-panel-slot{...;z-index:3;...background:var(--ea-glass-pane...)}
  错误卡/离线卡/标签条也有自己的背景（357-363、1288、1174），会盖住负层。原生选区又被全局设成 transparent（819），所以看不到任何替代高亮。
- 判定理由：注释说「高亮排在所有内容之下」，但设计忘了不透明背景也属于「内容」；选区高亮必须在文字所在的局部层叠上下文里，或被提到背景之上但不遮字。当前是确定的层级缺陷。
- 修复代价：中（按内容区域分层或在有背景的容器内复制高亮层；不能简单把 z-index 提到文字上方，否则会染色字形）。
- 波及：正文、模型页、教程页、错误/离线卡、标签条；要保留 pointer-events:none 和复制行为。
- 用户自测：模型页拖选模型 id，应该出现蓝色矩形；当前没有。

### A-08 折叠动画未取消/未串行，快速点「展开全文」再点「收起」会出现高度跳变
- 类型：真 bug
- 严重度：P2
- 位置：src/client/overlay.tsx:2659-2699（finish 在 2666，animate 在 2693）
- 现象：长回答展开/收起动画还没结束时再点同一个按钮，内容高度可能先反向、再跳回终态，或者按钮文字与画面状态短暂不一致。
- 触发路径：3081 打开一条长历史回答 → 点「展开全文」→ 在 220-640ms 内立刻点「收起」（或反过来）。
- 证据：每次点击都新建 WAAPI 动画，没有保存 animation 句柄，也没有 cancel 旧动画：
    2693  const animation = answer.animate([{ height: from + 'px' }, { height: to + 'px' }], ...)
    2697-2698  const done = animation && animation.finished; done.then(finish, finish)
  第一个动画的 finish 仍会在完成时移除 data-fold-anim/transition；第二个动画同时在改 height，两个 finished 回调无序竞争。
- 判定理由：这是用户主动交互，必须保证最后一次点击胜出；当前没有「取消前一动画」或「只允许最新 token 的 finish 生效」的守卫。
- 修复代价：小（保存当前 animation 并 cancel；或 ctx.foldToken++，finish 检查 token）。
- 波及：展开/收起、滚动锚定、流式期间的无关重画；不能取消正常完成的动画。
- 用户自测：长回答上快速双击「展开全文/收起」，最终应稳定在最后一次点击的状态，不应出现高度回弹。

### A-09 中文输入法组字时按 Esc 可能直接关掉整个浮窗
- 类型：真 bug
- 严重度：P2
- 位置：src/client/overlay.tsx:2505-2513；输入区 src/client/overlay.tsx:2478-2487
- 现象：用拼音/五笔组字时，按 Esc 取消候选词，浮窗也会关闭，用户丢失当前输入位置和上下文。
- 触发路径：3081 在输入框输入中文拼音，候选词未确认时按 Esc；在使用会把 keydown 冒泡到页面的浏览器/输入法组合下。
- 证据：root 的 Esc 处理没有检查 isComposing：
    2505  const keydown = (event: KeyboardEvent) => {
    2506    if (event.key === 'Escape') {
    2507      event.preventDefault()
    ...
    2512      close.click()
  而输入区的 keydown 只处理 Enter，并明确检查了 composing/isComposing（2478-2482），说明团队知道 IME 状态；Esc 分支漏了同样的判据。
- 判定理由：Esc 在中文输入中是取消候选词的高频键；如果事件到达页面，不能把「取消候选」解释成「关闭窗口」。是否需要冒泡取决于浏览器，但代码应防御。
- 修复代价：小（Esc 分支先 if (event.isComposing || composing || keyCode===229) return）。
- 波及：输入、选择模式、模型/教程页的 Esc；选择模式的 document 监听也应同样判 IME（当前没有输入焦点，风险较低）。
- 用户自测：3081 用中文输入法组字按 Esc；应只取消候选词，不应关窗。当前在部分浏览器会关窗。

### A-10 输入框焦点环对比度只有 1.53:1 / 2.05:1，且依赖 :has()，不支持时没有焦点提示
- 类型：真 bug / 无障碍
- 严重度：P2
- 位置：src/client/styles.css:43、80、1142-1162
- 现象：键盘 Tab 到输入框时，焦点提示只是一圈很淡的内阴影，浅色约 1.53:1、深色约 2.05:1，低于 3:1；在不支持 :has() 的引擎里，textarea 的全局 outline 被 1161 行清掉，而 :has 规则又被忽略，输入框完全没有焦点环。
- 触发路径：3081 用 Tab 从标题栏走到输入框，浅色主题观察焦点边界；或在旧 WebView/旧 Firefox 中打开浮窗。
- 证据：
    43  --ea-field-focus:rgba(0,0,0,.18)
    80  --ea-field-focus:rgba(255,255,255,.22)
    1142 .ea-field:has(.ea-input:focus-visible){ box-shadow: inset ... var(--ea-field-focus) }
    1161 .ea-field .ea-input:focus-visible{ outline:none }
  按 field 背景 #fdfdfe/#282a2e 合成：浅色焦点色 #cfcfd0 -> 1.53:1；深色 #57595c -> 2.05:1。
- 判定理由：焦点指示器需要 3:1 对比度；:has() 不是所有目标引擎都支持，fallback 不能是 outline:none。这是可访问性和兼容性问题，不是审美偏好。
- 修复代价：小（给 .ea-input:focus-visible 保留 outline 或更明显的内外双环；加 @supports selector(:has(*)) 的降级）。
- 波及：键盘导航、浅/深主题、旧浏览器；不要恢复「两层边框」的观感。
- 用户自测：Tab 到输入框，焦点边界应清晰可见；关闭 :has 支持（或旧浏览器）仍应看到焦点环。

### A-11 全局 previouslyFocused 会在切会话重建后丢失真正的打开来源
- 类型：真 bug
- 严重度：P2
- 位置：src/client/overlay.tsx:220、2099、2120
- 现象：从某入口打开浮窗后切换会话（entry 重建浮窗），再关闭时焦点回到 body 或一个已脱离文档的节点，而不是原来的入口按钮；键盘用户失去位置。
- 触发路径：在 3081 从会话 A 的入口打开浮窗 → 切到会话 B（浮窗重建）→ 点关闭；检查 document.activeElement。
- 证据：全局单例：
    220  let previouslyFocused: HTMLElement | null = null
    2099 previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : previouslyFocused
    2120 previouslyFocused?.focus()
  切会话时旧浮窗先被清理，activeElement 往往是 body；新 renderOverlay 把 previouslyFocused 覆盖成 body，后续 focus() 等于无效。也没有 isConnected 检查。
- 判定理由：焦点恢复必须绑定到打开这个浮窗的触发元素/每个 root，不能是跨重建共享的模块级变量；这是可复现的键盘可访问性缺陷。
- 修复代价：小（previouslyFocused 放到 OverlayContext 或闭包；关闭时只 focus 仍在文档中的元素）。
- 波及：打开/关闭、切会话、入口按钮、选择模式；不能抢走用户当前主动聚焦的输入。
- 用户自测：从入口打开 → 切会话 → 关闭；焦点应回到原入口（若还在），否则至少回到 body 可见位置，不能停在不可见节点。

### A-12 窄屏下 CSS 的 min-width:360/min-height:420 会覆盖 clampGeometry，浮窗溢出视口
- 类型：真 bug
- 严重度：P2
- 位置：src/client/styles.css:24-27；src/client/window.ts:38-45
- 现象：375px/360px/320px 宽的窗口上，clampGeometry 算出 343/328/288px，但 CSS min-width:360px 把实际宽度顶到 360px，右侧被裁掉；低高度窗口同理被 420px 撑出视口。
- 触发路径：3081 用 DevTools 设 375×667 或 320×568，打开浮窗；在 320 宽时右侧约 56px 不可见。
- 证据：
    styles.css:27  min-width:360px;min-height:420px;
    window.ts:42-45  const minWidth = Math.min(MIN_WIDTH, maxWidth); const width = Math.min(Math.max(input?.width ?? 420, minWidth), maxWidth)
  以 320 视口：maxWidth=288，clamp 返回 width=288，但 CSS min-width:360 使其实际为 360；x 默认 16，右边到 376，溢出 56px。
- 判定理由：clampGeometry 和 CSS 常量必须有一个统一来源，并且视口小于 392px 时不能强行 360；这是窄屏/移动端布局的真实溢出。
- 修复代价：小（用 CSS media query 把 min-width/min-height 降到 0 或变量，或让 clampGeometry 同步写实际 min；window.ts 已有 MIN_WIDTH 常量，需统一）。
- 波及：移动端、DevTools 窄屏、几何保存、拖动 resize；桌面 420×620 不应变化。
- 用户自测：375px 宽打开浮窗，右边缘不应被裁；320px 宽仍应完整显示（可滚动/自适应）。

### A-13 按钮可见文字变化后 aria-label 不更新；复制结果没有 live 提示
- 类型：真 bug / 无障碍
- 严重度：P2
- 位置：src/client/overlay.tsx:2187-2190、1025-1030；button 助手 src/client/overlay.tsx:257-267
- 现象：选择按钮从「选择主对话内容」变成「退出选择模式」时，读屏仍读「选择主对话中的步骤或工具卡片」；复制摘要按钮变成「已复制/复制失败」时，aria-label 仍是「把这份摘要复制到剪贴板」，结果不会被读出。
- 触发路径：3081 开读屏（或 DevTools Accessibility 面板）→ 点选择按钮进入模式 → 看按钮 accessible name；点「复制摘要」→ 看按钮名称。
- 证据：button 助手把 label 固化成 aria-label：
    257  function button(label, aria, ...) { ... 'aria-label': aria ...}
    2187 const select = button('选择主对话内容', '选择主对话中的步骤或工具卡片', ...)
    2174 select.textContent = '退出选择模式'  // aria-label 未改
    1028 const say = (text) => { node.textContent = text; ... }
  复制按钮的 aria-label 固定在 1026，say 只改 textContent；没有 role=status/aria-live。
- 判定理由：可见标签和 accessible name 不一致会违反 Label in Name，读屏用户无法知道当前按钮动作；复制结果属于异步状态反馈，必须可被读屏获知。
- 修复代价：小（动态按钮同时更新 aria-label；复制结果放到 aria-live=polite 的 status 节点）。
- 波及：选择模式、复制摘要、发送/停止按钮（发送/停止已单独更新 aria-label，是正确示例）。
- 用户自测：读屏点选择按钮，应听到「退出选择模式」而非旧名称；复制后应听到「已复制」或「复制失败」。

### A-14 纯空白 question 会渲染成空气泡
- 类型：真 bug
- 严重度：P3
- 位置：src/client/overlay.tsx:1486、1501、3161
- 现象：历史记录或当前状态里的 question 是空格/制表符/换行时，右侧出现一个只有内边距、没有文字的空白问句气泡，占用纵向空间；读屏也会读到一个空区域。
- 触发路径：让 /state 返回 question:'   '（或本地状态写入纯空白 question），打开历史/当前提问区。
- 证据：只做了 truthy 判断：
    1486  const question = String(record.question || '')
    1501  if (question) nodes.push(el('div', { class:'ea-turn-q', text: question }))
    3161  ctx.liveQuestion.textContent = showLive ? (state.question || '') : ''
  只读 fake DOM 复现：question='   ' 时 .ea-turn-q 存在，textContent 为三个空格。空字符串则不会出现，说明缺的是 trim 判据。
- 判定理由：纯空白没有语义，应当按空问题处理；但不要丢掉原始 question 用于历史/复制时，只在显示层判空。
- 修复代价：小（显示用 question.trim() 判空，历史文本仍可保留原文）。
- 波及：历史问答、当前这一问、空状态、复制；不影响正常带空格的中文问题。
- 用户自测：构造纯空白 question，历史区不应出现空气泡；当前会出现。

## B. 反直觉

### B-01 输入框/正文选区超过 12 或 24 个矩形后，后面的选中文字没有高亮
- 类型：反直觉
- 严重度：P2
- 位置：src/client/text-field.ts:94、223；src/client/page-selection.ts:33、149；src/client/styles.css:793-795、819
- 用户预期：Ctrl+A 或拖选很长一段文字时，所有被选中的文字都有蓝色高亮，至少能看出选区边界。
- 实际情况：输入框只画前 12 个 Range 矩形（MAX_BOXES=12），正文只画前 24 个块（MAX_BLOCKS=24）；超出部分没有自绘高亮，而原生 ::selection 已被设成 transparent，所以后面看起来完全没选中，复制却包含它们。
- 触发路径：在输入框粘贴 15 行以上文字后 Ctrl+A；或在长回答里拖选 30 行。
- 证据：
    text-field.ts:94  const MAX_BOXES = 12
    text-field.ts:223 const rects = selectionRects().slice(0, MAX_BOXES)
    page-selection.ts:33 const MAX_BLOCKS = 24
    page-selection.ts:149 if (out.length >= MAX_BLOCKS) return out
    styles.css:819 .dsh-explain-assistant-overlay[data-page-selection="on"] ::selection{background:transparent}
- 判定理由：性能上限可以保留，但必须在达到上限时退回原生选区或明确提示，不能悄悄让选中状态不可见；这是用户对「选中」的基本预期。
- 修复代价：中（动态池按可见区域增长，或在达到上限时关闭 data-page-selection/data-smooth 让原生高亮接管；注意不能遮字）。
- 波及：长文本选择、复制、键盘 Shift+方向键、性能；不能为了无限矩形让拖选变卡。
- 用户自测：长草稿 Ctrl+A 后滚动到底部，后面行也应有高亮；当前只有前 12 行。

### B-02 选中的依据标签超过 120px 后被 overflow:hidden 裁掉，无法逐条取消
- 类型：反直觉
- 严重度：P2
- 位置：src/client/styles.css:1169-1188
- 用户预期：多选 10 条、20 条依据时，输入框上方的标签会换行显示，所有 × 都能点到。
- 实际情况：.ea-target-bar 固定 max-height:120px 且 overflow:hidden，没有滚动；第 4 行之后的标签被裁掉，用户看不到也点不到对应的「取消这条选择」按钮。
- 触发路径：3081 在选择模式里加选 10 条以上依据，回到输入框上方观察标签区。
- 证据：
    1169  .ea-target-bar{display:flex;...flex-wrap:wrap;...}
    1178  max-height:120px;overflow:hidden;
    1187  .ea-target-bar[data-has-target=false]{max-height:0;...}
- 判定理由：已选标签的唯一逐条移除入口就在这些 × 上；裁掉它们使状态无法恢复，属于交互阻断，不是单纯的视觉取舍。
- 修复代价：小（改成可滚动/自适应高度，或把已选列表移到可滚动区域；保留入场/退场 max-height 过渡）。
- 波及：选择模式、输入区高度、focus、移动端；不要让 10 条标签把正文顶没。
- 用户自测：加选 10 条以上，滚动/查看标签区，应该能点到每一条的 ×；当前后几条不可见。

### B-03 从浮窗内拖到浮窗外的选区，浮窗内那一段高亮会整体消失
- 类型：反直觉
- 严重度：P2
- 位置：src/client/page-selection.ts:95-110；src/client/styles.css:819
- 用户预期：从回答里开始拖选、拖到浮窗外时，浮窗内已选中的文字至少保持高亮（或明确显示选区已失效）。
- 实际情况：Selection 的 commonAncestorContainer 变成 body，root.contains(body) 为 false，selectionScope 返回 null，整段浮窗内选区都不画；同时原生 ::selection 已透明，所以浮窗内看不到选区。
- 触发路径：在长回答中按住鼠标，从文字拖到浮窗边缘外 20px 再松开。
- 证据：
    101  const node = range.commonAncestorContainer
    106  if (!root.contains(elNode)) continue
    109  return ranges.length ? ranges : null
  只要跨出 root 边界，整个 range 被丢弃，而不是裁剪到 root 内。
- 判定理由：跨边界选择是常见的鼠标动作；正确行为应是把 range 裁到浮窗内或保留原生选区，而不是全部不画。
- 修复代价：中（对每个 range 做 root 边界裁剪；或跨边界时不设置 data-page-selection，让原生选区显示）。
- 波及：正文选区、复制、拖选跟随、边缘滚动；不能让浮窗内选区在拖动中闪烁。
- 用户自测：从回答中间拖到浮窗外再回来，浮窗内应有连续高亮；当前会整段消失。

## C. 设计取舍 / 风险

### C-01 3317 行 overlay + 69 个 OverlayContext 字段，页面状态没有单一状态机
- 类型：设计取舍 / 可维护性
- 严重度：P2
- 位置：src/client/overlay.tsx:1946-2079（OverlayContext）、2023-2551（骨架/交互）
- 现象：文件同时承担模型页、教程页、历史、折叠、滚动、选择、错误、几何、快捷键和文本输入，OverlayContext 有 69 个可变字段；data-view、modelOpen、tutorialOpen、DOM 面板是否存在、data-returning 多套状态共同决定页面。A-02、A-03 这类跨状态 bug 很容易再次出现。
- 触发路径：任何新增一个「整页」或缓存字段时，需要同步修改 open/close、render、dispose、focusable、historySignature 多处；很容易漏一处。
- 证据：只读统计：src/client/overlay.tsx 3317 行；OverlayContext 1946-2079 共 69 个字段；顶层 function/const 约 87 个（脚本统计，未改源码）。
- 判定理由：这不是要求立刻重构，而是当前复杂度的客观风险；本轮的模型/教程双开就是多真相状态机的直接后果。若后续继续加页面/缓存，建议把「页面状态」收敛成单一 enum + reducer，或至少把页面 open/close 抽成同一套控制器。
- 修复代价：大（跨文件重构、需要完整交互测试；不适合本轮修复 diff）。
- 波及：任何 UI 状态、焦点、缓存、动画；重构风险高，应先加测试再拆。
- 用户自测：不适用（结构性风险）；可用 A-02 的复现作为「多真相状态机」的回归样例。

### C-02 剪贴板只有「无法复制/复制失败」文案，没有非安全上下文 fallback，也没有同步异常保护
- 类型：设计取舍 / 边界
- 严重度：P3
- 位置：src/client/overlay.tsx:1025-1030
- 现象：HTTP/非安全上下文里 navigator.clipboard 为 undefined，点击「复制摘要」显示「无法复制」；权限被拒时 Promise reject 显示「复制失败」；没有 document.execCommand('copy') 兜底。若访问 clipboard 或 writeText 同步抛错，则不会进入 say，控制台异常且按钮无反馈。
- 触发路径：在非 HTTPS、非 localhost 的 3081 代理地址打开浮窗 → 展开压缩摘要 → 点复制；或用浏览器权限设置拒绝剪贴板。
- 证据：
    1027  const clipboard = (typeof navigator === 'object' ? navigator : undefined)?.clipboard
    1029  if (!clipboard?.writeText) { say('无法复制'); return }
    1030  clipboard.writeText(summary).then(() => say('已复制'), () => say('复制失败'))
  只有 then 的两个回调，没有 try/catch 包住 writeText 调用，也没有 execCommand 分支。
- 判定理由：当前对「无 API/权限拒绝」有诚实的文字降级，这点是好的；但没有 fallback 和同步异常保护，属于低概率边界，不是核心 bug。若产品要求复制必须可用，应补 fallback；若接受「明确告知无法复制」，至少应捕获同步异常。
- 修复代价：小（try/catch + 可选 execCommand fallback；复制结果另放 aria-live 状态节点，见 A-13）。
- 波及：压缩摘要复制、权限提示、读屏；不要伪造成功。
- 用户自测：HTTP 地址点复制应显示失败且不抛未处理异常；若产品要求可用，应能复制到剪贴板。

## D. 存疑（需实测确认，先不当作已确认 bug）

### D-01 提交后程序化清空 draft，自绘光标可能停在旧位置
- 类型：风险（需浏览器实测）
- 严重度：P2
- 位置：src/client/overlay.tsx:3278-3279；src/client/text-field.ts:285-291、317-328
- 现象：在输入框按 Enter 发送后，store 把 draft 清空，updateOverlay 执行 ctx.input.value = ''；但代码没有调用 field.refresh()。如果浏览器不因程序化 value 变化触发 selectionchange，镜像仍保留旧文本，光标会停在旧位置，直到用户再输入/滚动/失焦。
- 触发路径：3081 输入两行问题，按 Enter 发送（焦点仍在 textarea）；观察光标是否回到空输入框左上角。
- 证据：
    3278  // 只在草稿真的被外部改写（例如提交后清空）时回写输入框
    3279  if (ctx.input.value !== state.draft) ctx.input.value = state.draft
  全文没有 field.refresh 调用；text-field 的刷新入口只有 input 事件/焦点/滚动等。
- 判定理由：是否真的出现取决于浏览器对 value 赋值是否派发 selectionchange；需要真机确认。如果出现，这是「清空后 caret 归位」的直接 bug。
- 修复代价：小（value 变化后调用 field.refresh）。
- 波及：发送后清空、外部 draft 回填、光标/选区；不能刷新时抢走用户正在输入的内容。
- 用户自测：Enter 发送后立即看光标；应在空框左上角，若停在旧行末则确认。

### D-02 IME 组字期间 mirror 文本可能不包含组字串，自绘光标会跳到旧位置
- 类型：风险（需多浏览器实测）
- 严重度：P2
- 位置：src/client/text-field.ts:167-200、324-325
- 现象：custom caret 用 input.value 生成 mirror、用 selectionStart 定位；部分浏览器/输入法在 composition 期间 textarea.value 不包含组字串，此时 mirror 中文字比屏幕少，光标和选区位置会错，组字下划线可能被自绘 caret/选区层干扰。
- 触发路径：3081 用 Chrome/Safari + 拼音输入法，输入长拼音不确认，观察 caret 是否稳定在组字末端。
- 证据：syncMirror 只从 input.value 取数据：
    179  const data = input.value || '\u200b'
    185  const offset = Math.min(Math.max(input.selectionStart ?? 0, 0), textNode.data.length)
  compositionstart/end 只调用 refresh，没有专门隐藏 caret 或使用 composition 文本。
- 判定理由：不同 IME/浏览器对 value 的暴露时机不同，代码没有实测证据；先标存疑。
- 修复代价：中（composition 期间隐藏自绘光标/选区，交回原生；或读取 composition 文本；需要多浏览器测试）。
- 波及：中文/日文/韩文输入、光标、选区、下划线；不要阻断 Enter 发送的现有保护。
- 用户自测：用拼音组字不确认，观察 caret/选区是否乱跳、下划线是否被遮；与关闭 reduce/自定义层对比。

### D-03 text-field/page-selection 的显式 destroy 只由 MutationObserver 触发，宿主不摘节点时会残留监听
- 类型：风险（需确认宿主生命周期）
- 严重度：P3
- 位置：src/client/overlay.tsx:2535-2545；src/client/text-field.ts:334-340、357-365；src/client/page-selection.ts:239-242
- 现象：两个 handle 的返回值在 overlay 里没有保存，dispose 事件只清 controller/follow/markdown，不直接调用 field.destroy()/pageSelection.destroy()；它们靠 MutationObserver 发现 root 不在文档后才清理。正常关闭会 remove 节点，所以会清理；若 MutationObserver 不可用，或宿主保留 keepElement 节点不摘，document/window 监听和 rAF 会留下。
- 触发路径：在旧 WebView 禁用 MutationObserver，或宿主调用 dispose({keepElement:true}) 后不 remove；关闭浮窗后检查 document/window listener 数量。
- 证据：
    2535  root.addEventListener('dispose', () => { stopFollowLoop(ctx); controller.dispose(); answerView.dispose(); bodyObserver?.disconnect(); ... })
  没有 field.destroy/pageSelection.destroy；两个模块的 observer 是唯一自动清理入口。
- 判定理由：MutationObserver 在现代浏览器都有，正常路径可工作；只有宿主不按约定摘节点或引擎缺失才成为泄漏。先列风险，不作为已确认 P2。
- 修复代价：小（保存 handle，在 dispose 里显式 destroy；observer 保留兜底）。
- 波及：关闭/切会话/插件卸载、listener 泄漏、rAF；不能重复 destroy（handle 有 dead 守卫）。
- 用户自测：关闭浮窗后用 DevTools 检查 document selectionchange/window resize 监听是否减少；正常应只剩宿主自身。

## E. 核查通过 / 备注

- 输入框双层边框：DOM 上 mountTextField 创建 .ea-field 包住 textarea；CSS 中 .ea-input 是 border:0/box-shadow:none/background:transparent/outline:none，底板背景和 inset shadow 在 .ea-field 上，视觉边界只有一条。焦点环问题见 A-10，不是双层边框回归。
- !important：styles.css 全文件 0 处 !important，没有滥用。
- z-index 表：root 30；page-selection -1；field mirror 0、selection 1、input 2、caret 3；header actions 4；model/tutorial slot 3；resize 热区 3；jump/sticky 2；select-bar 2147481000。除 model/tutorial 同为 3（A-02）外，其余层级自洽；page-selection -1 的遮挡问题见 A-07。
- 监听器：document 的 escapeWhileSelecting 在 leaveSelectionMode 和 dispose 两处 remove；root keydown 在 dispose remove；controller.dispose 移除 window.ts 的 pointer/key 监听；text-field/page-selection 的 listeners 数组在各自的 destroy 里 remove。root/body/input 上的局部监听随 root 子树 GC，未发现永久强引用。唯一生命周期风险见 D-03。
- rAF/setTimeout：followStreaming 的 rAF 在 dispose、不流式、切换会话时由 stopFollowLoop 取消；text-field/page-selection 的 rAF 在 destroy 里 cancelAnimationFrame。仍有一些一次性 timer（自动首滚 0ms、compact 第二次定位 150ms、复制文案 1600ms、模型/教程退场 220ms）没有显式取消，但都在短时间后自然结束，未发现永久泄漏；如果宿主保留 detached 节点，回调会操作 detached DOM，属于 P3 边界。
- WeakMap：contexts（root -> ctx）和 chipEntries（targetBar -> Map）都是 WeakMap；chipEntries 在 resetPickRow 清 timer+clear，在退场 timer 里 delete；未发现长期持有已移除 DOM。真正跨会话强缓存的是 markdown.ts 的模块级 settledCache（不属本次 UI 范围，另行记录）。
- 选区分隔：text-field 的 selection layer z-index:1、input z-index:2、caret z-index:3；page-selection 是 root 的 z-index:-1 独立层；两边都监听 selectionchange，但文本输入框被 page-selection 排除（105 行），未发现两套 RAF 互相熄灭。page-selection 的可见性问题见 A-07/B-03。
- 长文本：.ea-turn-a 使用 word-break:break-word，Markdown 代码块有 overflow-x:auto，长单行没有发现横向溢出；输入框侧的长文本问题见 A-04。
- 空输入：form submit 用 input.value.trim() 判空，纯空白不会发送；question 纯空白显示问题见 A-14。
- 剪贴板：非安全上下文/权限拒绝会显示「无法复制/复制失败」，这点是诚实降级；无 execCommand fallback 和同步异常保护见 C-02。
- 现有测试：node --test tests/round8-fixes.test.mjs => 15 pass；node --test tests/fold-animation.test.mjs tests/close-animation.test.mjs tests/scroll-stability.test.mjs => 22 pass。没有发现这些测试覆盖 text-field/page-selection/自动跟随的新路径；建议补对应测试。
