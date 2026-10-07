import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { moduleFromSource, waitFor, settle } from './fixtures/runtime.mjs';

/**
 * 0.2.1 巡查修复的回归闸（Lead 负责的三条：占用少算回答正文、浮窗位置不保存、NUL 路径）。
 *
 * 这三条的**共同点**是：既有 450 条测试全绿，却一条都没抓住它们。原因写在各用例里。
 */

const occupancy = await moduleFromSource('src/host/occupancy.ts');

/**
 * 只够 `window.ts` 用的最小假元素：它只碰 style / addEventListener / setPointerCapture。
 * 刻意不用真 DOM —— 这条测试要的是「几何值有没有落到 style 上」这一个事实。
 */
function fakeElement() {
  return {
    style: {},
    addEventListener() {},
    removeEventListener() {},
    setPointerCapture() {},
    releasePointerCapture() {},
    closest() { return null; },
  };
}
const evidence = await moduleFromSource('src/host/evidence.ts');
const contracts = await moduleFromSource('src/host/contracts.ts');
const routesModule = await moduleFromSource('src/host/routes.ts');

/* ───────── 缺陷2：占用把回答正文算成了 0 个字 ───────── */

test('缺陷2 正例: 落库形状（answerText）的回答正文必须被计入占用', () => {
  // 这条**用真实落库字段名**构造。旧测试喂的是 answer —— 与被测代码读的是同一个错字段，
  // 所以「假数据与真数据不同形」，测试再绿也证明不了真实运行。
  const base = { systemPrompt: '提示词', contextWindow: 100000 };
  const without = occupancy.measureAssistantOccupancy({ ...base, records: [{ question: '问' }] });
  const withAnswer = occupancy.measureAssistantOccupancy({ ...base, records: [{ question: '问', answerText: '答'.repeat(400) }] });
  assert.ok(withAnswer.usedTokens > without.usedTokens,
    '带 answerText 的记录必须让占用变大；相等说明正文被读成了空（这正是本次修的缺陷）');
  assert.ok(withAnswer.parts.ownChars - without.parts.ownChars >= 400,
    '字符数差额必须覆盖回答正文长度，实际差 ' + (withAnswer.parts.ownChars - without.parts.ownChars));
});

test('缺陷2 反例: 只给旧字段 answer 的形状行为不变（向后兼容）', () => {
  const base = { systemPrompt: '提示词', contextWindow: 100000 };
  const legacy = occupancy.measureAssistantOccupancy({ ...base, records: [{ question: '问', answer: '答'.repeat(100) }] });
  const modern = occupancy.measureAssistantOccupancy({ ...base, records: [{ question: '问', answerText: '答'.repeat(100) }] });
  assert.equal(legacy.parts.ownTokens, modern.parts.ownTokens, '两种字段名必须算出同一份占用');
});

test('缺陷2 反例: answerText 为空串时不得回落到 answer', () => {
  const base = { systemPrompt: '提示词', contextWindow: 100000 };
  const empty = occupancy.measureAssistantOccupancy({ ...base, records: [{ question: '问', answerText: '', answer: '不该被算进去'.repeat(50) }] });
  const bare = occupancy.measureAssistantOccupancy({ ...base, records: [{ question: '问' }] });
  assert.equal(empty.parts.ownChars, bare.parts.ownChars,
    'answerText 明确是空串时不能拿 answer 兜底，否则会把一条空回答算成有内容');
});

test('缺陷2: carriedRecords 也必须带上回答正文', () => {
  const records = [
    { question: '旧的', answerText: '旧的正文', startedAt: '2026-01-01T00:00:00.000Z' },
    { question: '新的', answerText: '新的正文', startedAt: '2026-02-01T00:00:00.000Z' },
  ];
  const carried = occupancy.carriedRecords(records, '2026-01-15T00:00:00.000Z');
  assert.equal(carried.length, 1, '压缩后只保留压缩之后的记录');
  assert.equal(carried[0].question, '新的');
  assert.equal(carried[0].answerText, '新的正文', '映射必须把 answerText 带过来，不能只带 question');
  const noCompact = occupancy.carriedRecords(records, undefined);
  assert.equal(noCompact.length, 2, '没压缩过时全部计入');
  assert.equal(noCompact[0].answerText, '旧的正文');
});

test('缺陷2: 占用模块里读回答正文只允许一处判定', async () => {
  const source = await readFile(new URL('../src/host/occupancy.ts', import.meta.url), 'utf8');
  const code = source.split('/*').map(part => part.includes('*/') ? part.slice(part.indexOf('*/') + 2) : part).join('');
  const codeOnly = code.split(String.fromCharCode(10)).filter(line => !line.trim().startsWith('//')).join(String.fromCharCode(10));
  assert.ok(codeOnly.includes('answerTextOf'), '必须保留唯一的字段判定入口');
  // answerTextOf 自己当然要读两个字段；这里把它整段摘掉，检查**别处**还有没有直接读错字段。
  const helperStart = codeOnly.indexOf('export function answerTextOf');
  assert.ok(helperStart >= 0, 'answerTextOf 必须存在（上面的断言已查，这里是双重保险）');
  const helperEnd = codeOnly.indexOf('}', helperStart);
  const outsideHelper = codeOnly.slice(0, helperStart) + codeOnly.slice(helperEnd + 1);
  const direct = outsideHelper.match(/record[.]answer\b/g) || [];
  assert.equal(direct.length, 0,
    'answerTextOf 之外不得再直接读 record.answer（本次缺陷正是两处各读一遍错字段名造成的）；实际还有 ' + direct.length + ' 处');
});

/* ───────── 缺陷4：浮窗位置不保存 ───────── */

test('缺陷4: Operation 必须包含 geometry（否则路由解析会退回 state）', () => {
  assert.doesNotThrow(() => contracts.validateEnvelope({ schemaVersion: 1, sessionId: 's1', operation: 'geometry', payload: {} }),
    'geometry 必须是合法操作');
  assert.throws(() => contracts.validateEnvelope({ schemaVersion: 1, sessionId: 's1', operation: 'not-an-op', payload: {} }),
    '未知操作仍必须被拒');
});

function geometryRequest(body) {
  return new Request('http://host/api/explain-assistant/geometry?sessionId=s1', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('缺陷4 正例: POST /geometry 会把四个数交给宿主', async () => {
  const saved = [];
  const routes = routesModule.createExplainAssistantRoutes({ service: {
    isSessionAllowed: async () => true,
    isArchived: async () => false,
    saveGeometry: async (id, geometry) => { saved.push({ id, geometry }); return geometry; },
  } });
  const geometry = { x: 120, y: 64, width: 480, height: 700 };
  const response = await routes.get('/explain-assistant/geometry')(geometryRequest({
    schemaVersion: 1, sessionId: 's1', operation: 'geometry', payload: { geometry },
  }));
  assert.equal(response.status, 200, '合法位置必须被接受');
  const payload = (await response.json()).payload;
  assert.equal(payload.saved, true);
  assert.deepEqual(saved[0] && saved[0].geometry, geometry, '四个数必须原样落到宿主');
});

test('缺陷4 反例: 缺一个数 / 非有限数时不得写盘', async () => {
  const saved = [];
  const routes = routesModule.createExplainAssistantRoutes({ service: {
    isSessionAllowed: async () => true,
    isArchived: async () => false,
    saveGeometry: async (id, geometry) => { saved.push(geometry); return geometry; },
  } });
  const handler = routes.get('/explain-assistant/geometry');
  const bad = [
    { x: 1, y: 2, width: 3 },
    { x: 1, y: 2, width: 3, height: Number.NaN },
    { x: 1, y: 2, width: 3, height: '700' },
    { x: 1, y: 2, width: 3, height: Number.POSITIVE_INFINITY },
  ];
  for (const value of bad) {
    const response = await handler(geometryRequest({
      schemaVersion: 1, sessionId: 's1', operation: 'geometry', payload: { geometry: value },
    }));
    assert.equal(response.status, 400, '非法位置必须被拒：' + JSON.stringify(value));
  }
  assert.equal(saved.length, 0, '一份非法位置都不许写盘（宁可回到默认位置，也不要半个位置）');
});

test('缺陷4 反例: 宿主未实现 saveGeometry 时给中文错误，不得静默成功', async () => {
  const routes = routesModule.createExplainAssistantRoutes({ service: {
    isSessionAllowed: async () => true,
    isArchived: async () => false,
  } });
  const response = await routes.get('/explain-assistant/geometry')(geometryRequest({
    schemaVersion: 1, sessionId: 's1', operation: 'geometry', payload: { geometry: { x: 1, y: 2, width: 3, height: 4 } },
  }));
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.ok(new RegExp('[一-鿿]').test(body.error.message), '错误必须是中文：' + body.error.message);
});

test('缺陷4 反例: 已归档会话不得被写入位置', async () => {
  const routes = routesModule.createExplainAssistantRoutes({ service: {
    isSessionAllowed: async () => true,
    isArchived: async () => true,
    saveGeometry: async () => { throw new Error('不该被调用'); },
  } });
  const response = await routes.get('/explain-assistant/geometry')(geometryRequest({
    schemaVersion: 1, sessionId: 's1', operation: 'geometry', payload: { geometry: { x: 1, y: 2, width: 3, height: 4 } },
  }));
  assert.equal(response.status, 409, '已归档会话必须 409，不得写盘');
});

test('缺陷4 行为: 宿主存了位置，刷新时必须真的读回来（只写不读 = 位置照样丢）', async () => {
  // 这条是**被页面实测逼出来的**：Lead 第一版只做了「拖动 → 写宿主」，
  // 没有把宿主那份读回 registry。后果是整页重载后 registry 全新、位置回默认，
  // 磁盘上那份白存 —— verify-3082 在页面上看到「硬重载后回默认」才发现。
  //
  // 用真 refreshState 链路验：伪造 api.state 返回一组 geometry，断言它进了 registry。
  const seen = [];
  const { createClientPlugin } = await moduleFromSource('src/client/index.ts');
  const hostGeometry = { x: 137, y: 88, width: 512, height: 640 };
  const api = {
    state: async (id) => ({ payload: { records: [], hasEarlier: false, totalRecords: 0, unread: false, geometry: hostGeometry } }),
    models: async () => ({ payload: {} }),
    selectModel: async () => ({ payload: {} }),
    history: async () => ({ payload: {} }),
    historyResult: async () => ({ payload: {} }),
    ask: async () => {}, compact: async () => {},
    cancel: async () => {}, forget: async () => ({ payload: {} }),
    markRead: async () => ({ payload: {} }), geometry: async () => ({ payload: {} }),
  };
  const plugin = createClientPlugin({ api, session: { id: 'geo-readback' } });
  try {
    plugin.open();
    await waitFor(() => plugin.registry.get('geo-readback')?.geometry, { label: 'refreshState 应把宿主的位置读回 registry' });
    const got = plugin.registry.get('geo-readback').geometry;
    assert.deepEqual({ x: got.x, y: got.y, width: got.width, height: got.height }, hostGeometry,
      '宿主存的位置必须原样回到 registry，否则整页重载后位置仍会丢');
  } finally { plugin.dispose(); plugin.registry.remove('geo-readback'); }
});

test('缺陷4 反例: 宿主没给位置时不得把本地已有的位置抹掉', async () => {
  const { createClientPlugin } = await moduleFromSource('src/client/index.ts');
  const api = {
    state: async () => ({ payload: { records: [], hasEarlier: false, totalRecords: 0, unread: false } }),
    models: async () => ({ payload: {} }), selectModel: async () => ({ payload: {} }),
    history: async () => ({ payload: {} }), historyResult: async () => ({ payload: {} }),
    ask: async () => {}, compact: async () => {}, cancel: async () => {},
    forget: async () => ({ payload: {} }), markRead: async () => ({ payload: {} }), geometry: async () => ({ payload: {} }),
  };
  const plugin = createClientPlugin({ api, session: { id: 'geo-keep' } });
  try {
    // 先由浮窗交互写下一份本地位置（模拟用户刚拖过）
    plugin.registry.update('geo-keep', { geometry: { x: 11, y: 22, width: 333, height: 444 } });
    plugin.open();
    await settle(60);
    const got = plugin.registry.get('geo-keep').geometry;
    assert.equal(got?.x, 11, '宿主字段缺失 ≠ 用户没摆过位置：不能把本地那份抹掉；实际 ' + JSON.stringify(got));
  } finally { plugin.dispose(); plugin.registry.remove('geo-keep'); }
});

test('缺陷1b 行为: 用户自己按了停止，异步 catch 不得把「已按你的要求停止」覆盖成「请求已中断」', async () => {
  // 这是页面实测抓到的**真缺陷**（verify-3082 用 MutationObserver 抓到确定性覆盖）：
  //   t=911ms cancel() 写入「已按你的要求停止本次解释」
  //   t=926ms run() 的 .catch() 因 abort 触发，按 aborted 判成 '请求已中断'，把文案盖掉
  // 连跑 3 次完全一致 —— 不是偶发。落库那一半是对的（宿主走 deriveErrorReason），只有界面被覆盖。
  const { createClientPlugin } = await moduleFromSource('src/client/index.ts');
  let rejectAsk;
  const api = {
    state: async () => ({ payload: { records: [], hasEarlier: false, totalRecords: 0, unread: false } }),
    models: async () => ({ payload: {} }), selectModel: async () => ({ payload: {} }),
    history: async () => ({ payload: {} }), historyResult: async () => ({ payload: {} }),
    ask: (_id, _q, signal) => new Promise((_res, rej) => {
      rejectAsk = rej;
      signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); });
    }),
    compact: async () => {}, cancel: async () => ({ payload: {} }),
    forget: async () => ({ payload: {} }), markRead: async () => ({ payload: {} }), geometry: async () => ({ payload: {} }),
  };
  const plugin = createClientPlugin({ api, session: { id: 'stop-msg' } });
  try {
    plugin.open();
    void plugin.submit('一个很长的问题').catch(() => undefined);
    await waitFor(() => plugin.registry.get('stop-msg')?.phase === 'connecting', { label: '请求进入 connecting' });
    plugin.cancel();
    // 用户停止的瞬间文案必须立刻是对的
    assert.equal(plugin.registry.get('stop-msg').error, '已按你的要求停止本次解释',
      '点停止那一刻就应显示「已按你的要求停止本次解释」，实际 ' + JSON.stringify(plugin.registry.get('stop-msg').error));
    // 关键：等异步 catch 跑完，文案**不得**被改回去
    await settle(120);
    assert.equal(plugin.registry.get('stop-msg').error, '已按你的要求停止本次解释',
      '异步 catch 把用户的停止覆盖成了「请求已中断」——这正是页面实测抓到的缺陷；实际 ' + JSON.stringify(plugin.registry.get('stop-msg').error));
    assert.equal(plugin.registry.get('stop-msg').phase, 'interrupted', '相位仍应是「已停止」');
  } finally { plugin.dispose(); plugin.registry.remove('stop-msg'); }
});

test('改大小⑧向: 拖哪条边就改哪条边，方向必须与手一致（拖左边不能让窗口平移）', async () => {
  // 用户对上一版的定性是「**设计不符合操作直觉**」——不是看不见、不是点不到。
  // 所以入口从「角落一个字符」改成「拖边/拖角」。方向映射是这类交互最容易写反的地方，
  // 而且**写反了肉眼很难立刻看出**（窗口确实变了，只是变得不对），所以逐方向钉死。
  const { resizeByDirection } = await moduleFromSource('src/client/window.ts');
  const start = { x: 400, y: 200, width: 420, height: 500 };
  const box = (g) => [g.x, g.y, g.width, g.height].join(',');
  // 拖右边往右 60 → 只变宽，x/y 不动
  assert.equal(box(resizeByDirection(start, 'e', 60, 0)), '400,200,480,500', '拖右边：宽度 +60，位置不动');
  // 拖左边往左 60 → 宽 +60，且 **x 跟着左移 60**（这才是「拉宽」，不是「平移」）
  assert.equal(box(resizeByDirection(start, 'w', -60, 0)), '340,200,480,500', '拖左边：x 与 width 必须同时变，否则是平移不是拉宽');
  // 拖下边往下 40 → 只变高
  assert.equal(box(resizeByDirection(start, 's', 0, 40)), '400,200,420,540', '拖下边：高度 +40');
  // 拖上边往上 40 → 高 +40，y 上移 40
  assert.equal(box(resizeByDirection(start, 'n', 0, -40)), '400,160,420,540', '拖上边：y 与 height 必须同时变');
  // 右下角：宽高同增，位置不动
  assert.equal(box(resizeByDirection(start, 'se', 50, 30)), '400,200,470,530', '拖右下角：宽高同增');
  // 左上角：宽高同增，x/y 同减
  assert.equal(box(resizeByDirection(start, 'nw', -50, -30)), '350,170,470,530', '拖左上角：x/y/width/height 四项全动');
  // 右上角：宽增（位置不动）、高增且 y 上移
  assert.equal(box(resizeByDirection(start, 'ne', 50, -30)), '400,170,470,530', '拖右上角');
  // 左下角：宽增且 x 左移、高增
  assert.equal(box(resizeByDirection(start, 'sw', -50, 30)), '350,200,470,530', '拖左下角');
  // 缩到最小后继续往反方向拖，不得出现「越拖越偏」
  const tiny = resizeByDirection(start, 'w', 9999, 0);
  assert.ok(tiny.width >= 320, '宽度不得小于下限，实际 ' + tiny.width);
  assert.ok(tiny.x + tiny.width >= start.x, '缩到下限后左边不得越过原来的右边（会变成反向漂移），实际 x=' + tiny.x + ' w=' + tiny.width);
});
test('改大小⑧向 页面实测回归: 拖右边时左边必须钉住（页面抓到过 x 被拽走 64px）', async () => {
  // 这条是**页面实测抓到的真缺陷**，不是推演出来的：
  // 在 3082 上真拖右边 +80px → 宽度 420→500（对），但 x 从 847 变成 783（错，左移 64px）。
  // 用户感受是「窗口一边变宽一边乱跑」。根因：先 clampGeometry 再反推位置，
  // 而 clamp 在窗口将超出视口时会去改 x —— 拖右边把整个窗口一起往左拽。
  // 修法：夹**尺寸**、没被拖的那条边绝对不动。
  const { resizeByDirection } = await moduleFromSource('src/client/window.ts');
  // 几何值取「能完整放进默认视口（1024×768）」的一组：
  // 这样断言的是**方向规则本身**，不会被视口上限的夹取掩盖。
  // （模块内取不到测试里改的 globalThis.window，所以不去改它。）
  const near = { x: 400, y: 100, width: 420, height: 500 };   // 右边 820，视口内
  const r1 = resizeByDirection(near, 'e', 80, 0);
  assert.equal(r1.x, 400, '拖右边时 x 必须一动不动（修前会被 clamp 拽走）；实际 ' + r1.x);
  assert.equal(r1.width, 500, '拖右边宽度应 +80；实际 ' + r1.width);
  // 拖左边：右边钉住
  const r2 = resizeByDirection(near, 'w', -80, 0);
  assert.equal(r2.x + r2.width, near.x + near.width, '拖左边时右边必须钉住（x+width 不变）');
  assert.equal(r2.width, 500, '拖左边宽度应 +80');
  // 拖下边：上边钉住
  const r3 = resizeByDirection(near, 's', 0, 60);
  assert.equal(r3.y, 100, '拖下边时 y 必须一动不动；实际 ' + r3.y);
  // 拖上边：下边钉住
  const r4 = resizeByDirection(near, 'n', 0, -60);
  assert.equal(r4.y + r4.height, near.y + near.height, '拖上边时下边必须钉住');
  // 拖右下角：左边与上边都不动
  const r5 = resizeByDirection(near, 'se', 50, 40);
  assert.equal(r5.x, 400, '拖右下角时 x 不动');
  assert.equal(r5.y, 100, '拖右下角时 y 不动');

  // ── 贴边用例（**这才是页面实测抓到的那个情形**）────────────────────
  // 上面那组几何值完全在视口内，旧写法（先 clamp 位置）**不会触发**，
  // 所以它们证明不了缺陷 —— 我第一版就是这样，证伪脚本改回旧写法竟然全绿。
  // 页面实测：窗口 x=847、宽 420，视口约 1283 → 拖右边 +80 后旧写法把 x 拽到 783。
  // 这里用 node 的默认视口（1024×768）复刻同一情形：x=600、宽 420，右边 1020 已贴边。
  const edge = { x: 600, y: 100, width: 420, height: 500 };
  const e1 = resizeByDirection(edge, 'e', 80, 0);
  assert.equal(e1.x, 600, '贴边时拖右边：x 必须一动不动（旧写法会拽到 524）；实际 ' + e1.x);
  assert.equal(e1.x + e1.width, 1024 - 16, '右边应停在视口上限（宽度被夹是**正确**的）');
  // 拖下边同理：y 不动
  const edge2 = { x: 100, y: 300, width: 420, height: 400 };  // 下边 700，贴 768 底
  const e2 = resizeByDirection(edge2, 's', 60, 0);
  assert.equal(e2.y, 300, '贴底时拖下边：y 必须一动不动；实际 ' + e2.y);
});
test('改大小 最小尺寸闸: JS 的 MIN_* 必须与 CSS 的 min-width/min-height 逐值一致', async () => {
  // 页面实测抓到的真缺陷：JS 是 320×360，CSS 是 360×420。
  // 后果是用户拖动时**前 60px 完全没反应**（CSS 把窗口顶在 420，JS 以为还能更矮）。
  // 用户的定性是「设计不符合操作直觉」——手动了窗口不动，正是这个。
  // 这条闸直接读两份源码比对，防止以后再漂移。
  const css = await readFile(new URL('../src/client/styles.css', import.meta.url), 'utf8');
  const js = await readFile(new URL('../src/client/window.ts', import.meta.url), 'utf8');
  const cssBlock = css.match(/\.dsh-explain-assistant-overlay\{([\s\S]*?)\}/);
  assert.ok(cssBlock, '必须能定位到 .dsh-explain-assistant-overlay 的样式块');
  const cssMinW = Number((cssBlock[1].match(/min-width\s*:\s*(\d+)px/) || [])[1]);
  const cssMinH = Number((cssBlock[1].match(/min-height\s*:\s*(\d+)px/) || [])[1]);
  const jsMinW = Number((js.match(/export const MIN_WIDTH\s*=\s*(\d+)/) || [])[1]);
  const jsMinH = Number((js.match(/export const MIN_HEIGHT\s*=\s*(\d+)/) || [])[1]);
  assert.ok(Number.isFinite(cssMinW) && Number.isFinite(cssMinH), 'CSS 里必须能读到两个最小值');
  assert.ok(Number.isFinite(jsMinW) && Number.isFinite(jsMinH), 'JS 里必须能读到两个最小值');
  assert.equal(jsMinW, cssMinW, 'JS MIN_WIDTH 与 CSS min-width 必须一致，否则拖拽会出现「死区」：JS=' + jsMinW + ' CSS=' + cssMinW);
  assert.equal(jsMinH, cssMinH, 'JS MIN_HEIGHT 与 CSS min-height 必须一致，否则拖拽会出现「死区」：JS=' + jsMinH + ' CSS=' + cssMinH);
});
test('缺陷4c 行为: 几何值「后到」时必须补应用（首次打开不再停在默认位置）', async () => {
  // 页面实测（verify-3082）：硬重载后**首次打开**仍是默认 (600,16) 420x526，等 6 秒也不回填，
  // 只有「关闭重开」才应用 (220,32) 620x526。根因：浮窗创建那一刻 geometry 还没到，
  // 而 updateOverlay 只重画内容、**不重设位置**。
  // 这里直接对 attachWindowInteractions 验「后到的外部值会不会真的落到 DOM 上」。
  const { attachWindowInteractions, clampGeometry } = await moduleFromSource('src/client/window.ts');
  const root = fakeElement(); const handle = fakeElement(); const resize = fakeElement();
  const initial = clampGeometry({ x: 600, y: 16, width: 420, height: 526 }, 1400, 900);
  const controller = attachWindowInteractions(root, handle, initial, () => undefined, []);
  try {
    assert.equal(root.style.left, '600px', '初始应按默认位置渲染');
    const late = clampGeometry({ x: 220, y: 32, width: 620, height: 526 }, 1400, 900);
    assert.equal(controller.isInteracting(), false, '没有拖动时 isInteracting 必须为假');
    controller.applyExternal(late);
    assert.equal(root.style.left, '220px', '后到的几何值必须真的落到 DOM 上（这就是首次打开不生效的那一跳）');
    assert.equal(root.style.top, '32px', 'top 也要跟上');
    assert.equal(root.style.width, '620px', '宽度也要跟上');
    assert.equal(controller.isInteracting(), false, 'applyExternal 不应把自己算成「正在交互」');
  } finally { controller.dispose(); }
});
test('缺陷4 行为: 拖完立刻 dispose（关页面/切走）时，待写的位置必须当场冲刷出去', async () => {
  // 拖动是 400ms 防抖写的。若 dispose 时只清定时器不冲刷，用户「拖完立刻关页面」
  // 那一下位置就静默丢了 —— 而这条路径**真的在工厂体里引用了一个声明位置更靠后的
  // 变量（dispose 声明在 pendingGeometry 之前），顺序一改就会变成又一次 TDZ。
  // 所以这里不满足于正则，要真跑一次。
  const { createClientPlugin } = await moduleFromSource('src/client/index.ts');
  const saved = [];
  const api = {
    state: async () => ({ payload: { records: [], hasEarlier: false, totalRecords: 0, unread: false } }),
    models: async () => ({ payload: {} }), selectModel: async () => ({ payload: {} }),
    history: async () => ({ payload: {} }), historyResult: async () => ({ payload: {} }),
    ask: async () => {}, compact: async () => {}, cancel: async () => {},
    forget: async () => ({ payload: {} }), markRead: async () => ({ payload: {} }),
    geometry: async (id, geometry) => { saved.push({ id, geometry }); return { payload: {} }; },
  };
  const plugin = createClientPlugin({ api, session: { id: 'geo-flush' } });
  plugin.saveGeometry('geo-flush', { x: 5, y: 6, width: 700, height: 800 });
  assert.equal(saved.length, 0, '防抖窗口内不该已经写出去（否则这条测试证明不了冲刷路径）');
  plugin.dispose();
  await settle(80);
  assert.equal(saved.length, 1, 'dispose 必须把待写的位置当场冲刷出去，实际已写 ' + saved.length + ' 次');
  assert.deepEqual(saved[0].geometry, { x: 5, y: 6, width: 700, height: 800 }, '冲刷出去的必须是用户最后摆的那一份位置');
  plugin.registry.remove('geo-flush');
});
test('缺陷4: 客户端与浮窗必须真的调用保存（不是只加了个没人调的接口）', async () => {
  const source = await readFile(new URL('../src/client/index.ts', import.meta.url), 'utf8');
  assert.match(source, /api[.]geometry[(]/, '客户端必须真的调用 api.geometry');
  assert.match(source, /pendingGeometry[.]keys[(][)]/, 'dispose 必须冲刷待写的位置');
  const overlay = await readFile(new URL('../src/client/overlay.tsx', import.meta.url), 'utf8');
  assert.match(overlay, /plugin[.]saveGeometry[?][.][(]/, '拖动/缩放提交时必须调用 saveGeometry');
});

/* ───────── 潜在问题5：NUL 路径校验 ───────── */

test('潜在5: 含真正空字符的路径必须被拒（原写法挡的是「反斜杠+0」两个普通字符）', () => {
  const NUL = String.fromCharCode(0);
  assert.throws(() => evidence.assertRelativeWorkspacePath('a' + NUL + 'b'),
    (error) => error.message === 'WORKSPACE_PATH_INVALID', '真正的 NUL 必须被拒；这条在修复前是 ACCEPTED');
  assert.throws(() => evidence.assertRelativeWorkspacePath('..' + String.fromCharCode(92) + 'x'), () => true, '.. 仍必须被拒');
  assert.throws(() => evidence.assertRelativeWorkspacePath('/etc/passwd'), () => true, '绝对路径仍必须被拒');
  assert.doesNotThrow(() => evidence.assertRelativeWorkspacePath('src/a.ts'), '正常相对路径不得被误伤');
});