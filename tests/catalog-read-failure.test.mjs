import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeDom, FakeElement, moduleFromSource } from './fixtures/runtime.mjs';

/**
 * F2 修复：**目录读取失败不得被吞成「真的没有模型」**（t6 评审实测的缺陷）。
 *
 * ── 现象 ────────────────────────────────────────────────────
 * 宿主 src/index.ts 的 loadCatalog(...).catch(() => ({ groups: [], failures: [] }))
 * 把「目录读取失败」降级成「目录真的是空的」。此时 /state 本身 200、stateError 为
 * undefined、surfaceGate 判为 ready，界面于是显示
 * 「还没有选择模型 / 点这里选择模型（共 0 个可选）/ 还没有小助手历史 / 占用未知」，
 * 且**没有一句**「没读到」—— 正是用户点名要消掉的那类会被读成结论的文案。
 *
 * ── 修法的两条腿（缺一条都修不干净）──────────────────────────
 *   1. 宿主（src/index.ts）：失败**如实填进 failures**（带中文原因），不再降级成空目录。
 *   2. 客户端（overlay.tsx）：据此把「没读到」与「真的没有」区分开 ——
 *      前者走明确的中文说明且**不渲染任何空态结论**；后者（groups 空、failures 空）
 *      仍走原来的「暂时没有可用的模型」空态（那是真实结论，不是错值）。
 *
 * 只做第 1 条是不够的：failures 非空会让 hasLoadedContent 为真、档位留在 ready，
 * 空态结论照样会画出来。本文件的两组断言分别钉住这两条腿。
 */

const catalog = await moduleFromSource('src/host/catalog.ts');
const overlay = await moduleFromSource('src/client/overlay.tsx');

/**
 * 渲染一个状态，返回根元素与它的可见文本。
 *
 * @param expandModels 是否需要先点开模型列表。
 *   模型列表**默认折叠**（33 个模型平铺会把浮窗吃掉），模型名与「暂时没有可用的模型」
 *   这类空态文案都在折叠体里 —— 不展开就断言不到，会得到「文本不存在」的**假失败**
 *   （我第一版就是这么写的，4 条里红了 3 条，全是测试自己的问题）。
 */
function render(state, expandModels = false, act) {
  const dom = fakeDom();
  dom.document.createElementNS = (_ns, tag) => new FakeElement(tag);
  const live = {
    registry: { get: () => state, update: () => {}, subscribe: () => () => {} },
    api: {}, cancel() {}, submit: async () => {}, loadEarlier: async () => {}, retryState: () => {},
  };
  try {
    const root = overlay.renderOverlay(state, live);
    if (expandModels) {
      // 走真实用户路径：点标题栏的模型按钮，打开**独立的模型选择页**。
      // 新版入口是 .ea-model-trigger（旧版是正文里那张「模型」卡片上的折叠开关），
      // 模型名与空态文案现在都在选择页里 —— 不开页就断言不到，会得到假失败。
      const trigger = root.querySelectorAll('.ea-model-trigger')[0];
      if (trigger) trigger.click();
    }
    const snapshot = () => ({
      root,
      gate: root.getAttribute('data-surface'),
      text: root.textContent || '',
      view: root.getAttribute('data-view'),
      count: (root.querySelectorAll('.ea-model-panel-count')[0] || {}).textContent ?? '',
    });
    // act：给需要在**假 DOM 还活着**时做交互的用例用（例如点提示条里的「查看」）。
    // 不能在 render() 返回之后再点 —— 那时 dom.restore() 已经把 document 拆掉，
    // 任何按需创建的节点都会 ReferenceError: document is not defined。
    if (act) act(snapshot());
    return snapshot();
  } finally {
    dom.restore();
  }
}

/** 一个「已就绪但没有任何内容」的会话状态（F2 的最小复刻形状）。 */
function baseState(catalogValue, overrides = {}) {
  return {
    sessionId: 'f2', open: true, stateReady: true, stateError: undefined,
    records: [], text: '', tools: [], evidence: [], hasEarlier: false, draft: '',
    occupancyKnown: false, occupancyEstimated: false, phase: 'idle',
    compactState: { status: 'idle' },
    ...(catalogValue === undefined ? {} : { catalog: catalogValue }),
    ...overrides,
  };
}

/** t3/t1 实测那份「会被读成结论」的文案清单。 */
const CONCLUSIONS = ['共 0 个可选', '还没有选择模型', '还没有小助手历史', '占用未知', '暂时没有可用的模型'];
const leaked = (text) => CONCLUSIONS.filter(item => text.includes(item));

/* ================================================================== *
 * 1) 宿主侧：失败必须如实填进 failures，不得降级成空目录
 * ================================================================== */

test('F2 宿主: catalogReadFailure 返回「空 groups + 一条中文 failures」，而不是空目录', () => {
  const failure = catalog.catalogReadFailure(new Error('ECONNREFUSED 127.0.0.1:3082'));
  assert.deepEqual(failure.groups, [], '失败时没有可展示的模型组');
  assert.equal(failure.failures.length, 1, '必须留下一条失败记录（这正是「不再吞掉」的地方）');
  assert.equal(failure.failures[0].code, 'MODEL_CATALOG_UNAVAILABLE');
  assert.match(failure.failures[0].message, /没有读到模型目录/, '必须是中文说明，且说清是「没读到」');
  assert.match(failure.failures[0].message, /ECONNREFUSED/, '要带上真实原因，便于用户/我们定位');
  assert.match(failure.failures[0].message, /不代表/, '必须明说「不代表没有可用的模型」，否则仍会被读成结论');
  // 与「真的空目录」在形状上必须可区分：后者没有 failures。
  assert.notDeepEqual(failure, { groups: [], failures: [] }, '绝不能退化成「真的空目录」的形状');
});

test('F2 宿主: 接线处不得再用 catch 吞成空目录（源码钉子 + 行为验证）', async () => {
  const raw = (await import('node:fs')).readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  /*
   * ⚠️ 必须先剥掉注释再匹配。
   * 源码里那段修复说明**故意引用了**旧写法（`.catch(() => ({ groups: [], failures: [] }))`）
   * 来解释「为什么不能这么写」—— 直接对全文匹配会命中我自己的注释，得到一条**恒红**的断言。
   * （第一版就是这么红的，属于测试自身的缺陷。）
   */
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  assert.ok(!/\.catch\(\(\) => \(\{ groups: \[\], failures: \[\] \}\)\)/.test(code),
    'index.ts 的可执行代码里不得再出现「catch 成空目录」的写法（那正是 F2 的根因）');
  assert.match(code, /catalogReadFailure\(error\)/, 'loadState 必须走 catalogReadFailure 带上失败原因');

  // 行为验证：**真的把插件接上宿主、真的打一次 /state**，看它下发的 catalog 是什么形状。
  // 只钉源码字符串是不够的（写对了代码也可能没接上），所以这里走真实的注册链。
  const plugin = await moduleFromSource('src/index.ts');
  const handlers = new Map();
  const ctx = {
    get: () => undefined,
    // 目录服务抛错：这正是 F2 的触发条件。
    llm: { listProviders: async () => { throw new Error('目录服务不可达'); }, listModels: async () => [] },
    connection: { fetch: { register: ({ path, fetch }) => handlers.set(path, fetch) } },
    effect: () => {},
    slots: { inject: () => () => {}, register: () => () => {} },
  };
  plugin.apply(ctx);
  const handler = handlers.get('/api/explain-assistant/state');
  assert.ok(handler, 'apply 必须注册 /api/explain-assistant/state（否则下面的验证是空转）');
  const response = await handler(new Request('http://test/api/explain-assistant/state?sessionId=session-f2', { method: 'GET' }));
  assert.equal(response.status, 200, '/state 本身仍是 200 —— 这正是 F2 隐蔽的地方');
  const body = await response.json();
  const catalogOut = body?.payload?.catalog;
  assert.ok(catalogOut, '/state 必须随状态下发 catalog');
  assert.equal(catalogOut.failures.length, 1,
    '目录读取失败必须留下 failures 条目（旧实现在这里是 0，等于把失败吞掉）');
  assert.equal(catalogOut.failures[0].code, 'MODEL_CATALOG_UNAVAILABLE');
  assert.match(catalogOut.failures[0].message, /失败|没有读到/, '失败原因必须是中文');
  assert.deepEqual(catalogOut.groups, [], '失败时没有可展示的模型组');

  /*
   * ── 关于「宿主 catch 到底什么时候才会触发」的实测结论 ────────────────────
   *
   * 上面这条路（listProviders 抛错）**根本不会**走到 index.ts 的 catch：
   * discoverCatalog 内部的 callLlm 已经把异常收成 failures 了，它自己返回
   * {groups: [], failures: [MODEL_CATALOG_UNAVAILABLE]}。
   *
   * 也就是说：**t6 评审把根因记在宿主 catch 上，而实际可达的泄漏是客户端侧的**
   * （hasLoadedContent 把「任何 failures 条目」都算成已加载内容 →
   * 档位留在 ready → 渲染出「共 0 个可选 / 还没有选择模型 / 还没有小助手历史 / 占用未知」）。
   * 这一点我如实报告，见 evidence 文档。
   *
   * 宿主 catch 仍然要修（下面这条验证它）：只有当 discoverCatalog **真的抛**时它才生效，
   * 例如宿主把 listProviders 实现成一个会抛的取值器（形状异常）。那时旧写法会把
   * 「没读到」直接吞成空目录，客户端再也无从分辨。
   */
  const handlers2 = new Map();
  const throwingLlm = { listModels: async () => [] };
  Object.defineProperty(throwingLlm, 'listProviders', {
    get() { throw new Error('宿主 llm 服务形状异常'); },
  });
  const ctx2 = {
    get: () => undefined,
    llm: throwingLlm,
    connection: { fetch: { register: ({ path, fetch }) => handlers2.set(path, fetch) } },
    effect: () => {},
    slots: { inject: () => () => {}, register: () => () => {} },
  };
  plugin.apply(ctx2);
  const response2 = await handlers2.get('/api/explain-assistant/state')(new Request('http://test/api/explain-assistant/state?sessionId=session-f2b', { method: 'GET' }));
  const body2 = await response2.json();
  const catalog2 = body2?.payload?.catalog;
  assert.ok(catalog2, '/state 必须随状态下发 catalog');
  assert.equal(catalog2.failures.length, 1,
    'discoverCatalog 抛错时，宿主不得把它吞成空目录（这正是被修掉的那行）');
  assert.match(catalog2.failures[0].message, /没有读到模型目录/,
    '必须给出「没读到」的中文说明，实际=' + JSON.stringify(catalog2.failures[0].message));
  assert.ok(!(catalog2.groups.length === 0 && catalog2.failures.length === 0),
    '绝不能退化成「真的空目录」的形状');
});

/* ================================================================== *
 * 2) 客户端侧：F2 形状下不得出现任何「结论」，且必须能看到中文说明
 * ================================================================== */

test('F2 客户端: 目录读取失败（空 groups + 一条目录级 failures）不得显示任何空态结论', () => {
  const failure = catalog.catalogReadFailure(new Error('boom'));
  const { root, gate, text } = render(baseState(failure));
  assert.equal(root.getAttribute('data-surface'), gate, '根元素必须标出档位');
  assert.deepEqual(leaked(text), [],
    'F2 形状下不得出现任何会被读成结论的文案，实际泄漏 = ' + JSON.stringify(leaked(text)));
  assert.match(text, /没有读到模型目录/, '必须能看到「没读到目录」的中文说明，实际=' + JSON.stringify(text.slice(0, 200)));
  assert.ok(!/共 \d+ 个可选/.test(text), '不得报出「共 N 个可选」——那个数是从没读到的目录里编出来的');
});

test('F2 客户端: 目录读取失败时档位是 failed（不是 ready），并给出重试入口', () => {
  const failure = catalog.catalogReadFailure(new Error('boom'));
  const { root, text } = render(baseState(failure));
  assert.equal(root.getAttribute('data-surface'), 'failed',
    '「没读到目录」与「/state 失败」一样是「数据没到位」，不得判为 ready');
  assert.match(text, /重试/, '失败结局必须有出路：给重试入口');
});

test('F2 客户端: 目录级 failures 不得被当成「已加载内容」（否则档位会退回 ready）', () => {
  // 这是 F2 修复里最容易漏的一半：只让宿主填 failures 而不改 hasLoadedContent 的话，
  // failures 非空 → hasLoadedContent 为真 → surfaceGate 判 ready → 空态结论照样画出来。
  const failure = catalog.catalogReadFailure(new Error('boom'));
  const { root } = render(baseState(failure));
  assert.equal(root.getAttribute('data-surface'), 'failed', '目录级失败不能算「已有内容」');
});

test('F2 客户端: 已有正确旧内容 + 目录读取失败 → 档位仍 ready，但模型区不得报「共 0 个可选」', () => {
  /*
   * 这是 F2 修复里**最容易漏的那一半**，也是我第一次证伪时暴露出来的覆盖缺口：
   * 上面那些断言都在 'failed' 档位下跑，而 failed 分支会整块接管内容区、
   * 根本不渲染模型卡片 —— 于是「模型卡片自己的修复」一条都没被覆盖到
   * （变异 M3 把 catalogFailure 置空，当时 8 条全绿，就是这个缺口）。
   *
   * 真实场景：这个会话**已经有历史记录**（hasLoadedContent 为真），
   * 只是模型目录这次没读到。此时走 ready、保留旧内容，模型区照常渲染 ——
   * 它必须说「没读到目录」，而不是把自己数出来的 0 报成「共 0 个可选」。
   */
  const failure = catalog.catalogReadFailure(new Error('目录服务不可达'));
  const { root, gate, text } = render(baseState(failure, {
    records: [{ id: 'r1', question: '这是什么', answer: '这是答案', createdAt: '' }],
  }), true);
  assert.equal(root.getAttribute('data-surface'), 'ready',
    '已有正确旧内容时不得整块接管：应保留旧内容（契约允许的另一条出路）');
  assert.ok(!/共 \d+ 个可选/.test(text), '不得报「共 N 个可选」——那个数是从没读到的目录里编出来的');
  assert.ok(!text.includes('暂时没有可用的模型'), '不得把「没读到」说成「暂时没有可用的模型」');
  assert.match(text, /没有读到模型目录/, '必须说明是「没读到目录」，实际=' + JSON.stringify(text.slice(0, 260)));
  assert.ok(text.includes('这是什么'), '已正确的旧内容必须继续展示');
});

/* ================================================================== *
 * 3) 正常路径不得回归（这三条是「别为了修 F2 把真实结论也改掉」）
 * ================================================================== */

test('F2 回归: 目录真的返回且非空 → 模型列表照常渲染', () => {
  const { root, text, view } = render(baseState({
    groups: [{ provider: 'workbuddy', models: [{ provider: 'workbuddy', id: 'cn:deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash (WorkBuddy)' }] }],
    failures: [],
  }, { model: { provider: 'workbuddy', model: 'cn:deepseek-v4.1-flash', source: 'explicit' } }), true);
  // 打开的是**独立的模型选择页**（旧版是正文里的折叠卡片）：先确认真的切过去了，
  // 否则下面几条文本断言可能只是在读「还留在 chat 页」的旧内容，得到的绿没有意义。
  assert.equal(view, 'model', '点标题栏模型按钮后必须切到选择页（data-view=model）');
  assert.match(text, /DeepSeek V4.1 Flash \(WorkBuddy\)/, '正常目录必须照常渲染模型');
  assert.match(text, /本对话已选/, '已选模型仍要显示');
  assert.ok(!text.includes('没有读到模型目录'), '正常目录下不得出现「没读到」的说明');
  // 加强：不止「名字出现过」，还要**真的按提供方分组、真的建出可点选项**。
  assert.equal(root.querySelectorAll('.ea-model-group').length, 1, '一个提供方应渲染出一个分组');
  const options = root.querySelectorAll('.ea-model-option');
  assert.equal(options.length, 1, '一个模型应渲染出一个可点选项');
  assert.equal(options[0].getAttribute('aria-pressed'), 'true', '已选中的模型选项必须 aria-pressed=true');
  assert.equal((root.querySelectorAll('.ea-model-panel-count')[0] || {}).textContent, '共 1 个', '计数必须如实报出 1 个');
});

test('F2 回归: 目录真的返回且确实为空 → 仍走原来的「暂时没有可用的模型」空态', () => {
  // 关键字面是 failures: [] —— 与「读取失败」的区别只在这里，必须守住。
  const { root, text, view, count } = render(baseState({ groups: [], failures: [] }), true);
  assert.equal(view, 'model', '必须真的打开选择页（空态文案现在在选择页里）');
  assert.ok(text.includes('暂时没有可用的模型'),
    '真的空目录是**真实结论**，必须继续显示原来的空态，实际=' + JSON.stringify(text.slice(0, 200)));
  assert.ok(!text.includes('没有读到模型目录'), '真的空目录不得被说成「没读到」');
  // ── 计数强度说明（与任务书字面有出入，已如实上报）────────────────────────
  // 任务书写「断言计数不是「共 0 个」」，但**契约与实现都不支持那句话**：
  //   契约 §2：计数三种文本 ——「共 N 个」/「筛选出 M / N 个」/「没读到 → 没有读到模型目录（不报数）」。
  //   「真的读到了、确实为空」属于**第一种**，N=0 → 就是「共 0 个」。
  //   实测（renderOverlay 后点开 trigger）count.textContent === '共 0 个'。
  // 所以照字面断言「不是共 0 个」既与契约冲突、也与 src 冲突；而任务又要求「661 全绿、不改 src」，
  // 三者不可能同时成立。这里取**唯一自洽且不削弱**的写法：
  //   · 空目录必须**如实**报 0（钉成精确值，比「不检查」更强）；
  //   · 且**不得**是旧版那个把「没读到」与「真的空」混为一谈的「共 0 个可选」（含「可选」即为旧格式）；
  //   · 且**不得**是「没读到」的文案（下面已单独钉住）。
  assert.equal(count, '共 0 个', '真的读到了、确实为空 → 计数必须如实为「共 0 个」，实际=' + JSON.stringify(count));
  assert.ok(!count.includes('可选'), '不得退回旧版的「共 N 个可选」格式（那正是 F2 把没读到说成没模型的地方）');
  assert.ok(!count.includes('没有读到'), '真的空目录不得把计数说成「没读到」');
  // 空态「说是空的」与计数「报 0」必须同时成立 —— 只满足一个都可能是错的分支。
  assert.equal(root.querySelectorAll('.ea-model-option').length, 0, '空目录下不得渲染任何模型选项');
});

test('F2 回归/假绿陷阱: MODEL_CATALOG_PARTIAL 是真实失败信息，必须继续显示', () => {
  const partial = {
    groups: [{ provider: 'workbuddy', models: [{ provider: 'workbuddy', id: 'cn:deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash (WorkBuddy)' }] }],
    failures: [{ code: 'MODEL_CATALOG_PARTIAL', message: '模型提供方「deepseek-account」暂时没有可用模型。' }],
  };
  const state = baseState(partial, { model: { provider: 'workbuddy', model: 'cn:deepseek-v4.1-flash', source: 'explicit' } });

  // ① **不开面板**也必须看得见：宿主说的失败原文现在是正文里的 .ea-catalog-note。
  //    这条比旧版更严 —— 旧版它混在折叠卡片里，不开就看不到；现在「收起来也看得见」是硬要求。
  const closed = render(state, false);
  const note = closed.root.querySelectorAll('.ea-catalog-note')[0];
  assert.ok(note, 'PARTIAL 失败必须有正文提示条 .ea-catalog-note（不开面板也要可见）');
  assert.ok(note.textContent.includes('模型提供方「deepseek-account」暂时没有可用模型。'),
    'MODEL_CATALOG_PARTIAL 是宿主下发的真实信息，不得被当错值清掉；提示条实际=' + JSON.stringify(note.textContent));
  assert.equal(note.getAttribute('role'), 'status', '提示条必须以 role=status 播报给读屏');
  const openBtn = note.querySelectorAll('.ea-catalog-note-open')[0];
  assert.ok(openBtn, '提示条必须带「查看」按钮 .ea-catalog-note-open');
  assert.equal(openBtn.textContent, '查看', '「查看」按钮文案必须可读');
  // 失败原文必须真的挂在 .ea-model-failure 里（逐条一条一个），不是拼成一大段。
  assert.equal(note.querySelectorAll('.ea-model-failure').length, 1, '每条失败一个 .ea-model-failure');
  // 面板**关着**时不得残留选择页内容（否则就是「藏起来」而不是「摘掉」）。
  assert.equal(closed.root.querySelectorAll('.ea-model-option').length, 0, '面板关着时不得有模型选项');

  // ② 点「查看」应真的打开选择页，且真实模型的 provider 照常列出来。
  //    这一步必须在假 DOM 还活着时做（见 render 的 act 说明）。
  render(state, false, ({ root }) => {
    const btn = root.querySelectorAll('.ea-catalog-note-open')[0];
    assert.ok(btn, '提示条必须带「查看」按钮');
    btn.click();
    assert.equal(root.getAttribute('data-view'), 'model', '点「查看」必须切到选择页');
    const text = root.textContent || '';
    assert.ok(text.includes('DeepSeek V4.1 Flash (WorkBuddy)'), '有真实模型的 provider 照常列出来');
    assert.equal(root.querySelectorAll('.ea-model-option').length, 1, '面板里应有一个可点选项');
    assert.equal((root.querySelectorAll('.ea-model-panel-count')[0] || {}).textContent, '共 1 个', '计数如实报 1 个');
  });
});
