# dsh-explain-assistant · 解释小助手

> 一个 [DSH（DeepSeek Harness）](https://github.com/deepseek-ai) Web GUI 插件：
> 在主对话右上角放一个「**?**」，点开一个**独立浮窗**，用**白话中文**解释主 agent 正在做什么。
> **它只解释，不动手** —— 不向主 agent 发消息、不改它的上下文、不打断它的任务。

---

## 它解决什么问题

DSH 的主 agent 会自动执行一长串操作：读文件、跑命令、改代码、验证结果。
对**不写代码**的人来说，这一屏屏的步骤和输出基本是看不懂的：

- 它现在到底在干什么？卡住了还是在正常推进？
- 刚才那一步为什么非做不可？
- 它说"已完成"，是真的验证过了，还是只是它自己这么说？

**最自然的反应是直接去问主 agent —— 但那会打断它。** 你的一句追问会插进它的对话、
挤占它的上下文，甚至改变它接下来的判断。于是很多人干脆憋着不问，一路看到结束也不知道发生了什么。

这个插件把"提问"这件事**搬到旁边去做**：

| | 主 agent | 解释小助手 |
| --- | --- | --- |
| 你在哪问 | 主对话输入框 | 右上角「?」弹出的浮窗 |
| 会不会打断 | **会**：插进对话、占上下文 | **不会**：完全独立的一条请求 |
| 谁回答 | 正在干活的那个模型 | **你自己单独挑的**模型 |
| 能干什么 | 执行任务 | **只读**：七个只读工具，没有执行、没有写入 |

一句话：**它在旁边看着主 agent，随时把"它正在干什么"讲成人话，而主 agent 完全不知道你在问。**

---

## 推荐使用对象

**适合你，如果**：

- 你**不写代码**，看不懂主 agent 那一屏屏的命令和输出，但你需要知道它在干什么；
- 你想问「这一步为什么要做」，但又**不想打断**主 agent、不想污染它的上下文；
- 你希望提问是**问在暗处**的：主 agent 的对话里不会多出你问过的话；
- 你希望解释**有依据可查**，而不是听模型编一个像模像样的答案；
- 你在跑**长时间任务**（构建、批量改文件、多轮验证），中途想随时了解进展。

**不适合你，如果**：

- 你想要的是让 AI **替主 agent 干活、接管任务、自动纠错** —— 本插件**只读**，做不到，也不打算做；
- 你只是想换个主题或调 UI —— 那是另一个插件（如 `dsh-warm-ui`）的事；
- 你期望它**保证省钱**。小助手是独立请求，虽然与主 agent 对话隔离，
  但**同一账户可能共享费用、额度和资源竞争**，插件不承诺"绝无资源竞争"。

---

## 特点

下面每一条都能在代码里指到落点，不是宣传语。

| # | 特点 | 具体表现 | 落点 |
| --- | --- | --- | --- |
| 1 | **只解释，绝不动手** | 工具白名单只有 7 个**只读**工具；没有执行命令、写文件、联网、操作端口的工具 | `src/host/tools.ts` `TOOL_NAMES` |
| 2 | **不打扰主 agent** | 不写主对话、不把小助手问答注入主 agent 上下文、不取消主任务、不覆盖输入框草稿 | `docs/business-logic.md` §2；宿主侧无任何主对话写入路径 |
| 3 | **白话中文，术语当场解释** | 内置术语对照表（工具调用 / 命令 / 编译 / 上下文 …），出现术语时当场用一句话说明 | `src/host/prompts.ts` `TERM_HINTS` |
| 4 | **解释一个步骤覆盖四要素** | 在干什么 / 为什么做 / 实际产出 / 哪里可以调整，缺一不可 | `src/host/prompts.ts` `FOUR_ELEMENTS` |
| 5 | **依据分级，不把"它说的"当"已证实"** | 每条依据标「已观察到」/「仅据汇报」/「无从得知」 | `src/host/prompts.ts` `EVIDENCE_TIERS` |
| 6 | **信息不足就明说，不编造** | 拿不到信息时固定写出「该步未提供足够信息」，并说明缺什么 | `src/host/prompts.ts` `INSUFFICIENT_MARKER` |
| 7 | **每个主对话记录独立** | 一个主对话一份落库文件，切换主对话只切换显示，不串记录 | `src/host/persistence.ts` `pathFor` |
| 8 | **记录没完成会写明原因** | 不是笼统的"未完成"，而是分别给出超时 / 模型失败 / 触及上限 / 没拿到摘要 / 你主动停止，并给补救建议 | `src/shared/record-reason.ts` `RECORD_REASON_TEXT` |
| 9 | **模型单独选，不跟随主 agent** | 从 DSH 已配置模型里自己挑；**没选就不发请求**，绝不偷偷用默认模型 | `src/index.ts` `resolveModel` |
| 10 | **失败、超时都给中文提示** | 不静默失败；默认总超时 300 秒 / 空闲 120 秒，可用环境变量收紧（非法值自动回退默认，不会变成 0 或永久等待） | 默认值 `src/host/llm.ts` `DEFAULTS`；中文事件 `src/host/routes.ts`；覆盖 `src/host/timeout-config.ts` |
| 11 | **模型不可用时仍能看** | 已有问答、你选中的依据、以及一份**本地生成**的基本说明照常显示，并明确标注"这不是模型给出的解释" | `src/client/overlay.tsx` `offlineFallbackNodes` |
| 12 | **`/compact` 只压缩小助手** | 手动整理小助手自己后续回答所参考的上下文；完整问答记录仍保存可翻看；不触发主 agent 压缩 | `src/client/overlay.tsx`；`src/host/llm.ts` `compactAssistant` |
| 13 | **右下角占用圆环** | 显示的是**小助手自身**的占用，不用主 agent 的数值；估算会标「估算」，拿不到容量就显示「占用未知」 | `src/host/occupancy.ts`；`src/client/overlay.tsx` `ringNode` |
| 14 | **可拖动、可缩放的浮窗** | 不用挤压主对话宽度的固定侧栏；关掉不删记录，再打开继续追问 | `src/client/window.ts`；`src/client/entry.ts` |
| 15 | **只读工作区，越界直接拒绝** | 路径逃逸（绝对路径、`..`、符号链接出界）一律拒绝并给中文原因 | `src/host/evidence.ts` `resolveWorkspacePath` |
| 16 | **可核查的追问** | 追问会带上本会话既往问答，所以「那它为什么要这么做」能接上上一轮 | `src/index.ts` `buildMessages` |
| 17 | **未读提醒** | 有新回答时右上角按钮从「?」变成「? ·」，硬刷新后也在 | `src/client/header-badge.ts` |
| 18 | **主对话归档时自动清理** | 归档的主对话，其小助手记录与图片快照随之清理；**拿不准就绝不删** | `src/host/archive.ts`；`src/client/archive-watch.ts` |

### 界面里你会看到什么

- 右上角一颗 **「?」**（有新内容时是「? ·」）。
- 点开是一个浮窗，标题「解释小助手」，第一次打开会给你 4 个快捷问题：
  「它现在在干什么」「这一步为什么这么做」「这步实际产出了什么」「哪里可以调整」。
- 点浮窗里的「选择主对话内容」，再去点主对话里的**任意一条步骤卡片或一段助手汇报**，
  就能针对那一条提问；浮窗里会常驻显示「正在围绕这条内容提问」。
- 浮窗底部有 `/compact` 按钮、右下角有占用圆环、顶部有历史记录（可展开单条完整内容）。

---

## 环境要求

| 项 | 要求 |
| --- | --- |
| DSH | `0.1.7-rc.2`（**实测环境**；本插件依赖 DSH 的 `connection` / `sessionQuery` / `fs` / `attachments` / `llm` / `tokenMeter` 六个服务与两个客户端插槽） |
| profile | `web`（本插件只在 DSH Web GUI 里有意义） |
| 运行时 | **不需要构建**：`lib/` 已随仓库提供，clone / 装完即可用 |
| Node | 实测 v24（仅开发时需要：`typescript` + `esbuild` 是 devDependencies） |

`dsh.client.inject` 声明了三个宿主框架包作为能力来源（DSH 自带，不需要单独装）：
`@deepseek-ai/dsh-client-ui-renderer`、`@deepseek-ai/dsh-client-ui-session`、`@deepseek-ai/dsh-api-workspace-controller`。

---

## 安装

一条命令，装进你的 Web profile（把 `web` 换成你实际在用的 profile 名）：

```bash
dsh plugin add --profile web 'git+https://github.com/yunliya-cuter/dsh-explain-assistant.git'
```

装完**不用手改任何配置**：本包自带 `cordis.patch.yml`，并通过 `package.json` 的
`dsh.bundle.patch` 指向它，DSH 会在安装后自动把包名写进 profile 的
`dsh.profile.bundles` 并在进程内重新装配。

然后**刷新浏览器（F5）**。

### 验证装好了

1. 打开任意一个主对话，右上角工具行里应出现一颗 **「?」**。
2. 点它，浮窗出现，标题是「解释小助手」。
3. 先点「模型」选一个模型（**不选就不发请求**），然后点一个快捷问题。
4. 几秒内应看到白话中文回答；右下角圆环显示占用百分比或「占用未知」。

### 从本地工作区开发（改代码即时生效）

不想走 git 安装、就在本仓库上改代码时，直接把**本地路径**作为 spec 装进来：

```bash
dsh plugin add --profile web "$(pwd)"
```

改完源码后重新构建、刷新浏览器：

```bash
npm run build                        # tsc 产出 lib/*.js + esbuild 打包 lib/client.js
node --test tests/*.test.mjs         # 跑测试（本仓库没有 npm test 脚本）
```

> `node --test tests/` 这种带目录的写法会失败，**必须带通配** `tests/*.test.mjs`。

### 卸载

```bash
dsh plugin remove --profile web dsh-explain-assistant
```

插件卸载时会自行移除路由、订阅、监听器、计时器和客户端入口。

---

## 它导出什么

| 入口 | 文件 | 说明 |
| --- | --- | --- |
| `.` | `lib/index.js` | **宿主半边**：六个 DSH 服务、10 条认证路由、持久化、只读工具执行、模型调用 |
| `./client` | `lib/client.js` | **浏览器半边**：右上角「?」入口、浮窗 UI、选择与拖动缩放 |
| `./cordis.patch.yml` | `cordis.patch.yml` | 包自带的组合补丁层，声明本包自己的 loader entry |
| `./package.json` | `package.json` | |

宿主路由（全部挂在 `/api/explain-assistant/` 下，走 DSH 的认证 Fetch，客户端不生成 token）：
`state`、`history`、`history-result`、`models`、`select-model`、`ask`（SSE）、
`compact`（SSE）、`in-flight`（取消）、`forget`（归档清理）、`mark-read`。

---

## 它把数据存在哪

- 位置：`$DSH_HOME/explain-assistant/sessions/<主对话 id>.json`，一个主对话一份文件；
  图片快照在 `$DSH_HOME/explain-assistant/sessions/<主对话 id>/images/`。
- 写入方式：每个主对话一条**独立串行写队列**，写临时文件、校验后**原子替换**正式文件。
- 它**只写自己的目录**：不碰工作区文件，不碰 DSH 共享附件，不碰主对话记录。
- 主对话被归档时，对应的小助手记录与图片快照会被清理（**判据极其保守：拿不准就绝不删**）。

---

## 已知限制（如实写）

1. **归档墓碑是内存态**：插件重启后丢失。若重启后仍有"晚到的写入"，理论上可能把已清理的文件重建出来；
   兜底是下一次归档检查。
2. **修复前落库的老记录补不出依据**：早期版本落库时没写 `evidence` / `tools` / `images`，
   这些老记录展开后仍然是空的，**无法追溯补齐**。
3. **占用百分比是启发式估算**：小助手不是 DSH 会话，没有可精确测量的 Session，
   所以按固定文本密度估算并**始终标注「估算」**；拿不到模型容量时显示「占用未知」，不编造数字。
4. **依据分级第三级较难出现**：「无从得知」需要一条"未完成 / 不可读"的卡片，
   在正常数据下不易构造，因此这一级主要是防御性设计。
5. **"切换主对话不串记录"只在接口层验证过**：页面上的点击级验证尚未做。

---

## 这个仓库里有什么、没有什么

**有**：`src/`（TypeScript 源码）、`lib/`（构建产物，随仓库提供）、`tests/`（418 条测试）、
`scripts/`（构建与本地部署脚本）、`docs/business-logic.md`（业务需求，权威基线）、
`docs/implementation-plan.md`（实施方案）、`README.md`、`LICENSE`。

**没有**（被 `.gitignore` 排除，不进公开仓库）：
`node_modules/`、`*.tgz`（打包产物）、`package-lock.json`、
以及 `docs/` 下的**内部工作底账**（`HANDOFF.md`、`status.md`、`gap-analysis.md`）与
`docs/evidence/`（含本机访问 token 的取证报告，以及 50MB 的本地 GUI 截图）。
排除理由：这些是本地审计材料，含本机 token 与运行截图，不属于插件本身。

---

## 测试

```bash
node --test tests/*.test.mjs
```

当前 **418 条测试全部通过**（0 失败）。测试覆盖：协议与错误码、会话归属与工作区边界、
只读工具白名单与串行执行、SSE 顺序与取消、原子写入与损坏恢复、压缩事务、
React/store 状态、指针与键盘交互、归档清理等。

> 本项目的经验之谈：**测试全绿 ≠ 页面上没问题**。多条真实缺陷（未读徽标从不显示、
> 滚动抽搐、落库缺字段）都是测试全绿时在真实页面上发现的，因此每个改动都要求在
> 真实页面上复核一次。

---

## 许可证

[MIT](./LICENSE)
