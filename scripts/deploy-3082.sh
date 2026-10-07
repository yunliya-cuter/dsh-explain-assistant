#!/bin/bash
# 部署 dsh-explain-assistant 到某个 DSH 档案。
#
# 为什么需要你在自己的终端里跑：这条链要写会话工作区之外的 DSH profile 目录
# （/home/dsh/.dsh/profiles/web）与日志目录（/mnt/d/WSL/logs），
# agent 的文件沙箱（workspace-write）不允许，提权也被自动复核拒绝。
#
# 用法：
#   bash scripts/deploy-3082.sh <version>                          # 测试档案（默认）
#   bash scripts/deploy-3082.sh <version> --home <DSH_HOME>        # 指定档案
#   bash scripts/deploy-3082.sh <version> --no-restart             # 只装不重启
#   bash scripts/deploy-3082.sh <version> --start-port <port>      # 装完起在指定端口
#
# **为什么要有 --no-restart**：3081 是用户本人正在用的实例，且已约定
# 「3081 的重启只能由用户本人做」。装进它的档案时必须跳过重启这一步，
# 否则脚本会替用户重启——那是明令禁止的。
set -e

VERSION=""
DSH_HOME_TARGET=""
DO_RESTART=1
START_PORT=3082
while [ $# -gt 0 ]; do
  case "$1" in
    --no-restart) DO_RESTART=0; shift ;;
    --home) DSH_HOME_TARGET="$2"; shift 2 ;;
    --start-port) START_PORT="$2"; shift 2 ;;
    -h|--help) sed -n "2,22p" "$0"; exit 0 ;;
    -*) echo "不认识的参数：$1"; exit 1 ;;
    *) VERSION="$1"; shift ;;
  esac
done
if [ -z "$VERSION" ]; then
  echo "用法: deploy-3082.sh <version> [--home <DSH_HOME>] [--no-restart] [--start-port <port>]"
  exit 1
fi
if [ -z "$DSH_HOME_TARGET" ]; then DSH_HOME_TARGET=/home/dsh/.dsh-test; fi

REPO=/mnt/d/projects/dsh-explain-assistant
PROFILE="$DSH_HOME_TARGET/profiles/web"
TGZ="$REPO/dsh-explain-assistant-$VERSION.tgz"

echo "=== 目标档案 ==="
echo "  DSH_HOME : $DSH_HOME_TARGET"
echo "  PROFILE  : $PROFILE"
if [ "$DO_RESTART" = 1 ]; then echo "  重启     : 是（端口 $START_PORT）"; else echo "  重启     : 否（--no-restart）"; fi
test -d "$PROFILE" || { echo "找不到档案目录 $PROFILE"; exit 1; }

echo "=== 0) 检查包存在 ==="
test -f "$TGZ" || { echo "找不到 $TGZ，请先在仓库里 npm pack"; exit 1; }
ls -l "$TGZ"

echo "=== 1) 改 profile 依赖 ==="
cd "$PROFILE"
node -e "
const fs=require('fs');
const p=JSON.parse(fs.readFileSync('package.json','utf8'));
p.dependencies=p.dependencies||{};
p.dependencies['dsh-explain-assistant']='file:$TGZ';
fs.writeFileSync('package.json', JSON.stringify(p,null,2)+'\\n');
console.log('dep ->', p.dependencies['dsh-explain-assistant']);
"

echo "=== 2) pnpm install ==="
export npm_config_cache=/tmp/npmcache
pnpm install --offline --force --ignore-scripts 2>&1 | tail -6

echo "=== 3) 已装版本 ==="
node -e "console.log(require('$PROFILE/node_modules/dsh-explain-assistant/package.json').version)"

echo "=== 4) 校验产物里确有本次改动（缺失即失败，不是只打印）==="
# 教训：这里原来只检查 0.1.24 时代的三个字符串，而且**只打印不报错** ——
# 于是装上一份旧包、或新功能没打进产物时，脚本照样报「部署完成」。
# 校验的作用是拦住错包，所以：每个标记出现 0 次就 exit 1。
# 标记随版本更新：新增能力时在这里加一行，别让校验落后于功能。
LIB="$PROFILE/node_modules/dsh-explain-assistant/lib"
check() { # check <标记> <文件...>
  local needle="$1"; shift
  local n=0
  for f in "$@"; do
    # **必须用 -F（明文）**：这些标记是要在产物里逐字找到的字符串，不是正则。
    # 用正则时方括号会被当字符组 —— 例如 close[1][0] === marker 会变成「close1 或 0」的字符类，
    # 于是标记明明在产物里却报「缺少标记」，把一次正确的部署中止掉（本轮已实际踩到两次）。
    c=$(grep -c -F -- "$needle" "$f" 2>/dev/null || true)
    n=$((n + ${c:-0}))
  done
  echo "  $needle -> $n"
  if [ "$n" -eq 0 ]; then echo "  ✗ 缺少标记「$needle」：装上的产物不是本次构建，部署中止。"; exit 1; fi
}
# 注意：这里**故意没有**做「产物里不得出现旧禁令字样」的字符串检查。
# 实测：开关写成三元表达式后，构建产物里**两个分支的字符串都在**
# （true 分支与 false 分支都被打进包里），所以 grep 旧字样必然命中 ——
# 那样的检查会误判成「放宽没生效」并把一次正确的部署中止掉。
# 真正要看的是**运行时**那个值，见下面 4b) 的 node 核验。
# 宿主侧：把某条记录的完整内容交出来（0.1.34 F2/F3）
check loadHistoryResult "$LIB/index.js"
# 宿主侧：落库时真的带上 evidence/tools/images（0.1.35；此前只有 9 个字段，面板永远是空的）
check buildRecordContent "$LIB/host/routes.js"
# 客户端：归档信号订阅（0.1.37 F6）+ 未读徽标订阅（0.1.37）
check archive-watch "$LIB/client.js"
check header-badge "$LIB/client.js"
# 客户端：冷启动未读预取（0.1.38）+ 宿主：归档后真正删除（0.1.38）
check primeUnread "$LIB/client.js"
# 事故修复（0.1.39）：归档集合必须显式判 phase === 'ready' 才当权威，
# 否则「未就绪的合法空数组」会被当成基线 → 历史归档被整体误判为新归档 → 批量误删。
check "phase !== 'ready'" "$LIB/client/archive-watch.js"
# 宿主：标记已读路由（0.1.40；此前只有 markUnread，没有「清除未读」，导致打开浮窗后徽标清除不了）
check mark-read "$LIB/index.js"
# 客户端（0.1.41）：可能缺失的 api 调用必须都过 callApi 包装。
# 教训：直接写 api.markRead(...) 时，遇到没有该方法的 api（旧宿主/精简替身）会
# TypeError **同步抛出 open()**，浮窗整个打不开 —— 一个「锦上添花」的请求不该有这种破坏力。
# callApi 是「同步调用 + try 兜同步抛出 → 转成被拒绝的 Promise」，让 TypeError 与网络错误
# 走同一条 .catch() 降级路径。历史证据：该写法曾让全量 371 条里 7 条红；证伪：改回裸调用 → 7 条红。
check "callApi" "$LIB/client.js"
# 并且 markRead 确实走了它（否则「包了但没用」也会假绿）
check "callApi(() => api.markRead" "$LIB/client.js"
# 宿主（0.1.42）：state 必须额外下发 totalRecords —— 客户端据此自己算「还有没有更早」。
# 教训：宿主 state 恒按「首屏=最近一页」算，只要总数 > 一页就恒说 hasEarlier:true；
# 客户端照抄它 → 一次刷新（**打开浮窗就会触发**）就把「已翻到底」改回「还能翻」，
# 再点一次就把同一批记录重复前置拼接（loadEarlier 无去重）→ 界面 24→28→32 而磁盘仍 24，
# 即「界面在说假话」（违反 §10 不静默失败）。用户可见缺陷，由 verify-3082 页面发现。
check "totalRecords" "$LIB/index.js"
# 客户端（0.1.42）：loadEarlier 前置拼接必须按 id 去重（防御性，任何原因重复取回都不得渲染重复条目）。
check "existingIds" "$LIB/client.js"
# 客户端（0.1.43）：4 处「刷新导致倒退」的同类修复 —— 宿主响应更旧/更少时不得覆盖本地较新状态。
# 由 F2 分页缺陷归纳出的通用模式（客户端把宿主「某一页/某一时刻」的结论当全局真相）。
# ①模型：宿主没下发 ≠ 用户没选（旧写法无条件覆盖 → 刚选的模型从界面消失）
check "payload.model ? { model" "$LIB/client.js"
# ②占用：回答进行中，本地从 usage 学到的占用比宿主那份更新（旧写法刷新后圆环熄灭）
check "occupancyEstimated" "$LIB/client.js"
# ③展开续读：按 id 去重（与 loadEarlier 同模式；旧写法同一页取回两次 → 依据显示两遍）
check "seen.has" "$LIB/client.js"
# ④未读：预取响应晚于「打开浮窗」时不得把已清除的未读重新点亮（旧写法徽标清除后又亮）
#    用单调序号而非时间戳 —— 预取与打开常在同一毫秒，时间戳比较会失效。
check "everOpenedSeq" "$LIB/client.js"
check "lastOpenedSeq" "$LIB/client.js"
# 宿主（0.1.44 F7）：超时预算可通过环境变量覆盖，从而能在页面上几秒内真实触发一次超时。
# 教训：F7 的实现在 0.1.33 就有了，但默认 300s/120s 让「靠干等验证」不现实，这条一直悬着。
# 校验三件事：模块在、接线通、严格校验没被删（value <= 0 这条是防「误配把超时变 0」）。
test -f "$LIB/host/timeout-config.js" || { echo "  ✗ 缺少 $LIB/host/timeout-config.js：超时配置模块没打进产物，部署中止。"; exit 1; }
check readConfiguredTimeouts "$LIB/index.js"
check DSH_EXPLAIN_ASSISTANT_TOTAL_TIMEOUT_MS "$LIB/host/timeout-config.js"
check "value <= 0" "$LIB/host/timeout-config.js"
# 宿主/客户端共用（0.1.45 D1）：记录「为什么没完成」的原因码与中文文案的**唯一来源**。
# 教训：原因原先只写在 routes.ts 的 SSE 分支里（只有当时在看界面的人可见），**没落库**；
# 整页重载后界面只能显示笼统的「未完成」，用户不知道为什么，追问时模型也拿不到原因。
# 校验三件事：模块在、落库带上它、界面重建走同一份（否则又会出现第二份文案）。
test -f "$LIB/shared/record-reason.js" || { echo "  ✗ 缺少 $LIB/shared/record-reason.js：原因模块没打进产物，部署中止。"; exit 1; }
check deriveRecordReason "$LIB/host/routes.js"
check RECORD_REASON_FIELD "$LIB/host/routes.js"
check RECORD_REASON_TEXT "$LIB/client.js"
check 这条记录没有完成 "$LIB/client.js"
# compact 跟进（0.1.46）：模型**正常结束但没吐出摘要**这条路径原先完全不落痕迹，
# 记录被写成 complete=true —— 重载后看起来像「压缩成功」，而界面上当时显示的是「压缩失败」。
# 即「一次失败被记成了成功」，比 D1 本身更严重（§9.1 失败清楚提示）。
# 校验两件事：第四种原因存在；status 由「干净成功」决定而不是只看 result.complete。
check empty_result "$LIB/shared/record-reason.js"
check deriveCompactReason "$LIB/host/routes.js"
check cleanSuccess "$LIB/host/routes.js"
# 异常/取消路径也要留痕（0.1.47，D1 家族第三例）：
# 原先 run() 的 catch 只发事件、**不落库** → 适配器抛异常、用户点停止时，
# 那次提问在磁盘上彻底不存在（实测四种情形记录数都是 0）。重载后连「我问过」都看不到。
# 校验三件事：共用推导函数在、catch 里真的落库、区分「用户停止」与「失败」。
check deriveErrorReason "$LIB/host/routes.js"
check "service.saveRecord?.(" "$LIB/host/routes.js"
check stopped "$LIB/shared/record-reason.js"
# 注意：**不要**再把标记写成 Promise.resolve().then(() => api.markRead ——
# 0.1.41 中后期已统一为 callApi，旧标记串在产物里不存在，会误拦正确部署。
check forgotten "$LIB/index.js"
# 宿主：forget 路由（0.1.37；此前 service.forget 定义了却无入口可调）
check forget "$LIB/index.js"
# 客户端：滚动抽搐修复（0.1.36）。用户实测「浮窗内滚轮一滚就抽搐」。
# 修法是删掉重画路径上无条件的「读 scrollTop → 写回 scrollTop」，所以这里断言它**不再出现**：
# 有 bug 的 0.1.35 产物里 scrollTop 出现 6 次，修复后只剩 2 次（浮窗首开归零 + 换记录归零）。
n=$(grep -o 'scrollTop' "$LIB/client.js" | wc -l)
echo "  scrollTop 出现次数 -> $n (期望 2)"
if [ "$n" -ne 2 ]; then echo "  ✗ scrollTop 出现 $n 次（期望 2）：滚动抽搐修复不在产物里，部署中止。"; exit 1; fi
# 客户端侧：展开入口与离线降级层
check 查看完整内容 "$LIB/client.js"
check ea-record-detail "$LIB/client.js"
check ea-target-bar "$LIB/client.js"
check ea-offline "$LIB/client.js"

# ══════════════════════════════════════════════════════════════════════════
# 0.2：小助手的上下文里「包含」主 agent 的上下文，且 /compact 不碰它
#
# 这一组校验对应三条用户明令要求，缺一条都算没做到：
#   ① 包含：主 agent 的工具调用 / 正文 / 压缩摘要 / 用户对它说的话，都进入小助手的上下文；
#   ② 更新到最新：提问时现取（readSurface），不是缓存副本；
#   ③ 分清 + 隔离：两份上下文分区，且 /compact 只压小助手自己那段。
# 教训：③ 是最容易漏的一条 —— ask 与 compact 共用同一个 buildMessages，
# 下游 compactAssistant 会把整份 messages 送去摘要。只做 ① 不做 ③，
# 用户一点 /compact，主 agent 那部分就被摘要顶替，功能一按就废。
# ══════════════════════════════════════════════════════════════════════════

# 模块必须在产物里（否则下面的接线检查会「找不到符号」而不是「功能没做」）
test -f "$LIB/host/session-context.js" || { echo "  ✗ 缺少 $LIB/host/session-context.js：主 agent 上下文模块没打进产物，部署中止。"; exit 1; }
# ① 读的是「当前模型可见表面」，且不经过被关掉的全文搜索
check readSurface "$LIB/host/session-context.js"
# ① 压缩摘要的识别判据必须是 source.kind，不能按 type 筛
#   （摘要那条事件的 type 是 user/message，和用户说的话**同一个类型**；
#    按 type 筛会把摘要漏掉，或把用户的话一起当成摘要）
check compact-checkpoint "$LIB/host/session-context.js"
# ① 宿主注入的样板文字不得混进「用户对主 agent 说过的话」
check runtime-context "$LIB/host/session-context.js"
check plan-mode "$LIB/host/session-context.js"
# ② 提问路径必须**现取**，且不经过 loadState 的短时缓存
check readMainlineContext "$LIB/index.js"
# ③ 压缩路径必须显式排除主 agent 段（这一条就是本次的核心修复）
check "mode === 'compact'" "$LIB/index.js"
# ③ 两条路径的差异必须一眼可见：routes 把 op 传下去
check "op === 'compact'" "$LIB/host/routes.js"
# 分区：两份上下文各有标题，模型才分得清
check "主 agent 的上下文" "$LIB/host/prompts.js"
check "小助手自己的上下文" "$LIB/host/prompts.js"
# 悬停：圆环必须带 title，且文案里有两块的名字
check "主 agent 转移" "$LIB/client.js"
check occupancyParts "$LIB/client.js"
# 记账：两块之和必须等于注入量（否则用户悬停看到的数对不上账）
check occupancyParts "$LIB/index.js"

# ══════════════════════════════════════════════════════════════════════════
# 0.2.1：整插件巡查查出的四条缺陷
#
# 共同点值得记下来：这四条此前**全都没有被 450 条测试抓住**。
# 原因分两类，校验也据此设计：
#   · 「假数据与真数据不同形」——占用那条；
#   · 「只覆盖了主路径、没覆盖边界」——停止与位置两条。
# ══════════════════════════════════════════════════════════════════════════

# ① 停止被误报成「模型失败」。
# 根因是 llm.ts 里 abortByParent 引用的 aborted 声明在它后面（暂时性死区），
# 抛 ReferenceError → 事件变成 error/INTERNAL_ERROR → 原因被记成 model_failed。
# 用户点「停止」，看到的是「模型那边返回了错误」，记录里也写成模型失败。
check wasAborted "$LIB/host/llm.js"
check looksAborted "$LIB/host/llm.js"
# 中止必须用 ExplainAssistantError 抛：路由的 toErrorBody 只认这个类型，
# 用裸 Error 的话事件虽是 aborted，内容却是 INTERNAL_ERROR「没能完成这次操作」。
check "ExplainAssistantError('ABORTED'" "$LIB/host/llm.js"
# 原因推导要认 AbortError（实测 discoverCatalog 在 abort 时抛的正是它，不带我们的 ABORTED 码）
check "name === 'AbortError'" "$LIB/shared/record-reason.js"

# ② 占用把回答正文算成了 0 个字。
# occupancy 读 record.answer，而落库真实字段是 answerText —— 实测 3082 真实记录
# 少算 1107 字（ownTokens 601 应为 878）。这个缺陷测试抓不到，因为**测试喂的假数据
# 用的是同一个错字段名**，假数据与真数据不同形。
check answerTextOf "$LIB/host/occupancy.js"
check answerText "$LIB/host/occupancy.js"

# ③ 提示词自相矛盾：无依据时 renderEvidence 叫模型说「该步未提供足够信息」，
# 而 SYSTEM_PROMPT 明令「不得因为没选中片段就说这句话」。实测模型在回答里公开拒绝该指令。
# 有主 agent 上下文时改用中性措辞，没有时保持逐字节不变。
check hasMainline "$LIB/host/prompts.js"
check 本次没有点选具体步骤 "$LIB/host/prompts.js"

# ④ 浮窗位置不保存：contracts 里早有 geometry 字段，但**从来没有任何写入方**，
# 用户拖好位置、关掉再打开又回默认位置。
check saveGeometry "$LIB/index.js"
check saveGeometry "$LIB/client.js"
check "/explain-assistant/geometry" "$LIB/index.js"
# 拖动提交时真的调用它（否则「加了接口但没人调」也会假绿）
check "plugin.saveGeometry?.(current.state.sessionId" "$LIB/client.js"
# **只写不读 = 位置照样丢**：宿主存了那份位置，刷新时必须读回来。
# 教训（2026-10-04 部署后才发现）：第一版只做了「拖动→写宿主」，没做读回；
# 整页重载后 registry 全新、位置回默认，磁盘上那份白存 —— 是 verify-3082 在页面上
# 看到「硬重载后回默认」才暴露的。这条标记钉住那个读回分支。
check "payload.geometry" "$LIB/client.js"

# ⑤ 空字符路径校验：原文写的是 includes('\0')，在源码里那是「反斜杠 + 0」两个普通字符，
# 实测含真正 NUL 的路径能通过。
check "u0000" "$LIB/host/evidence.js"

# ══════════════════════════════════════════════════════════════════════════
# 0.2.3：0.2.2 部署后在真实页面上复验暴露出来的两条「修了但没真修好」
#
# 教训：0.2.2 的代码层测试全绿，页面复验却判未通过。两条都属于
# 「修了主路径、漏了它旁边那一跳」——上一轮四条缺陷里有两条同类，这一轮又来两条。
# ══════════════════════════════════════════════════════════════════════════

# ① 用户点「停止」后，界面文案被异步 catch 覆盖。
# 实测（verify-3082 用 MutationObserver 抓的确定性序列）：
#   t=911ms cancel() 写入「已按你的要求停止本次解释」
#   t=926ms run() 的 .catch() 因 abort 触发，按 aborted 判成「请求已中断」把文案盖掉
#   连跑 3 次一致 —— 不是偶发。落库那一半是对的（宿主走 deriveErrorReason）。
# 修法：给请求加 stoppedByUser 标记，catch 里标记为真就**不再写 error**。
check stoppedByUser "$LIB/client.js"
check "request.stoppedByUser === true" "$LIB/client.js"

# ② 整页硬重载后**首次打开**不应用已存位置，必须关闭重开才生效。
# 实测：首次打开 (600,16) 420x526（默认），关闭重开后 (220,32) 620x526。
# 根因：浮窗创建那一刻 state.geometry 还没到（首次打开时 /state 是异步的），
# 而 updateOverlay 只重画内容、**完全不重设位置** → 几何值后到也永远不生效。
# 修法：拖动控制器加「应用外部几何值」入口，updateOverlay 在几何值变化时补应用；
# 两条守卫防倒退：正在拖动/缩放时不覆盖、与上次已套用值相同则不动。
check isInteracting "$LIB/client.js"
check applyExternal "$LIB/client.js"
check appliedGeometry "$LIB/client.js"

# ══════════════════════════════════════════════════════════════════════════
# 0.2.4：改大小的入口从「角落一个字符 ◢」换成「拖边、拖角」
#
# 用户对上一版的定性，原话是：
#   「不是，意思是这个设计不符合操作直觉，不是说它看不到用不了。」
# 也就是说他嫌的**不是**字号小或颜色淡，而是「要去角落找一个符号才能改大小」
# 这件事本身不合他平时用窗口的经验 —— 普通窗口是拖边、拖角就能改。
# ══════════════════════════════════════════════════════════════════════════

# 八个方向热区必须真的存在（四个边 + 四个角）
check "ea-resize-edge" "$LIB/client.js"
check "data-resize-direction" "$LIB/client.js"
check "ea-resize-se" "$LIB/client.js"
check "ea-resize-nw" "$LIB/client.js"
# 方向映射必须是**单一来源**：曾经同一条规则写了两遍（w 分支里令 x=…，末尾又钳一次），
# 两处数学等价 → 拆掉任一处另一处都会补上 → 证伪脚本看不出红（一次真正的假绿）。
check resizeByDirection "$LIB/client.js"
# 拖动时要有可见反馈（正在改大小）
check "data-resizing" "$LIB/client.js"


# ══════════════════════════════════════════════════════════════════════════
# 0.2.7：回答正文解析 Markdown 记号
#
# 用户原话：「没有对 md 的符号进行解析。我希望能够解析的同时还保证性能。」
# 两件事是并列的：记号要变成格式，且流式吐字时不能卡。下面两条各验一半。
# ══════════════════════════════════════════════════════════════════════════

# ① 解析：渲染器确实被打进客户端产物，且浮窗走的是它。
check "ea-md-p" "$LIB/client.js"
check "ea-md-codeblock" "$LIB/client.js"
check "ea-md-h" "$LIB/client.js"
check "ea-md-li" "$LIB/client.js"
check "ea-md-quote" "$LIB/client.js"
check "ea-md-strong" "$LIB/client.js"
check "mountMarkdown" "$LIB/client.js"
check "createMarkdownRenderer" "$LIB/client.js"
check "cachedMarkdownNodes" "$LIB/client.js"
# 历史正文与详情正文也必须走渲染器（只在主正文上做等于漏了一半）
check "ea-record-answer" "$LIB/client.js"
check "ea-detail-answer" "$LIB/client.js"
# 安全：不得使用 HTML 注入 API。未信任文本只能走 createElement / textContent。
if grep -q "innerHTML" "$LIB/client.js"; then
  echo "  X 客户端产物里出现了 innerHTML —— 未信任文本绝不能走 HTML 注入"; exit 1
fi

# ② 性能：增量机制必须在产物里（块级冻结 + 代码块只追加 + 只换尾部）。
# 这三样少任何一样，「保证性能」就落空，所以逐个点名，不靠「大概有」。
check "frozenBlocks" "$LIB/client.js"
check "frozenCount" "$LIB/client.js"
check "blockRenders" "$LIB/client.js"
check "codeAppends" "$LIB/client.js"
check "codeChars" "$LIB/client.js"
# 0.2.8：修掉一个用户一眼能看见的缺陷 —— 列表在流式下重复显示。
# 根因是 mountMarkdown 里「容器实际挂的节点」与「已挂节点记账」脱节：
# 某块第一次被冻结时冻结出新对象、容器里却是旧对象，按「前缀肯定对了」跳过 → 两份内容并存。
# 这一条必须点名 firstDiff：它就是对同一性对齐的那段逻辑，退回旧写法这个标记就没了。
check "firstDiff" "$LIB/client.js"

# ══════════════════════════════════════════════════════════════════════════
# 0.2.9：对抗性审查（impl-history）报出的 6 条真缺陷，逐条点名
#
# 这 6 条都不是推演出来的，是队友用独立探针实测复现的，且每条都做过证伪。
# 其中两条会造成**内容损失**（用户能看到的东西没了），两条会让页面**卡死**——
# 后者正对着用户「保证性能」那条要求，所以必须逐条在产物里点名，不靠「大概有」。
# ══════════════════════════════════════════════════════════════════════════

# ① CRLF：模型经某些网关会吐 CRLF，行尾回车会让标题/列表全然不识别、段落不再切分（整篇退化）。
#    修法：切行时去掉行尾回车，于是行对象多了一个独立的 end 变量。
#    标记选 start: i, end: nl —— 它是本次修复独有的形态，且不含反斜杠与方括号，
#    免得 grep 把标记当正则（带 [] 或反斜杠 r 的标记本轮已连续踩坑三次）。
check "start: i, end: nl" "$LIB/client.js"
# ② 缩进的闭合围栏（0-3 空格）原先认不出来 → 围栏永不闭合 → **后面所有正文被吞进代码块**。
check "close[1][0] === marker" "$LIB/client.js"
# ③ 有序列表起始号：'3.' 开头原先渲染成从 1 开始，与原文编号对不上。
check "startNumber" "$LIB/client.js"
check 'setAttribute("start"' "$LIB/client.js"
# ④ 列表项里的代码块原先跑到列表外面；⑤ 空行分隔的同类列表原先被拆成两个。
#    两者同一个根因：空行被当成列表结束。修法见 nextNonBlank。
check "nextNonBlank" "$LIB/client.js"
# ⑥ 未闭合/深嵌套方括号的平方级耗时（32k 实测 2624ms → 7ms），正对「保证性能」。
check "buildCloseIndex" "$LIB/client.js"
check "closeIndexOf" "$LIB/client.js"

# ══════════════════════════════════════════════════════════════════════════
# 0.2.10：两条在页面上会看到的缺陷 + 两处覆盖遗漏
# ══════════════════════════════════════════════════════════════════════════

# ① 定稿那一刻整棵正文 DOM 被重建 → 用户看到「答完的瞬间闪一下」。
#    根因：定稿分支 reset 后整份重渲染，产出的全是新对象。修法：沿用流式成果，只补齐后面几块。
#    标记取 rawOf —— 它就是「按源码片段比对、保留已有前缀」那段逻辑，退回旧写法这个标记就没了。
check "rawOf" "$LIB/client.js"
# ② 缓存把同一批节点交给多个容器 → 真实浏览器 appendChild 是移动语义 → 历史正文间歇性变空。
check "deliverSettled" "$LIB/client.js"
check "contentKey" "$LIB/client.js"
# ③ 覆盖遗漏：压缩摘要与推理过程同样是模型写出来的正文，原先没走 Markdown 渲染。
check "ea-md-scope" "$LIB/client.js"

# 0.2.12：Markdown 表格渲染（用户放行「表格始终允许」，但渲染器原本**不支持表格** ——
# 块类型只有 paragraph/heading/code/list/quote/hr，若只改提示词，模型真吐表格时
# 用户看到的会是一堆裸露的竖线。所以渲染器与提示词必须一起上）。
check "ea-md-table" "$LIB/client.js"
check "ea-md-th" "$LIB/client.js"
check "ea-md-td" "$LIB/client.js"
check "isTableStart" "$LIB/client.js"
check "tableCells" "$LIB/client.js"
# 0.2.12：提示词两档放宽的开关（代码块/JSON 临时、表格长期）。
check "ALLOW_TEMPORARY_CODE_BLOCKS" "$LIB/host/prompts.js"
check "长期允许" "$LIB/host/prompts.js"
# 4b) 提示词两档要看**运行时求值结果**，不是查字符串：
#   三元开关的两个分支都会被打进产物，所以 grep 分不出当前生效的是哪一支。
#
#   当前期望状态（用户 2026-10-07 的第二条要求）：**临时放宽已收回**。
#     · 代码块 / JSON -> 禁令原话应已回来（开关 = false）
#     · Markdown 表格 -> **仍长期允许**（不归开关管，收回时必须仍在）
#   这两条要一起断言：只验「禁令回来了」会漏掉「表格被误收走」，反之亦然。
node -e "
const m = require('$LIB/host/prompts.js');
const s = m.SYSTEM_PROMPT;
const BAN = '不要输出代码块';
const TABLE = '长期允许';
const TEMP = '临时允许';
if (m.ALLOW_TEMPORARY_CODE_BLOCKS !== false) { console.log('  X 临时放宽未收回：开关应为 false，实际 ' + m.ALLOW_TEMPORARY_CODE_BLOCKS); process.exit(1); }
if (!s.includes(BAN)) { console.log('  X 收回不干净：SYSTEM_PROMPT 里应已恢复「' + BAN + '」'); process.exit(1); }
if (s.includes(TEMP)) { console.log('  X 收回牵连了不该动的东西：仍出现「临时允许」'); process.exit(1); }
if (!s.includes(TABLE)) { console.log('  X 表格被误收走：SYSTEM_PROMPT 里缺少「长期允许」那一条（它不归开关管）'); process.exit(1); }
console.log('  OK 运行时提示词：代码块/JSON=已收回（禁令已恢复），表格=仍长期允许');
"

# 回归闸：表格测试文件必须在仓库里（它是渲染器补表格的验收标准，缺了就没人守）。
for t in tests/markdown-table.test.mjs; do
  test -f "$REPO/$t" || { echo "  ✗ 缺少回归测试 $t"; exit 1; }
done

# 回归闸：对抗性测试文件必须在仓库里（它是这 6 条的验收标准，缺了就没人守）
for t in tests/markdown-adversarial.test.mjs; do
  test -f "$REPO/$t" || { echo "  X 缺少回归测试 $t"; exit 1; }
done

# 回归闸：渲染器与接线各自的测试文件都必须在仓库里。
for t in tests/markdown-render.test.mjs tests/markdown-wiring.test.mjs; do
  test -f "$REPO/$t" || { echo "  X 缺少回归测试 $t"; exit 1; }
done

# 回归闸：这几条各自的测试文件必须在仓库里（部署不校验测试，但缺了要有人知道）
for t in tests/audit-0.2.1-lead.test.mjs tests/abort-before-stream.test.mjs; do
  test -f "$REPO/$t" || { echo "  ✗ 缺少回归测试 $t"; exit 1; }
done

if [ "$DO_RESTART" = 0 ]; then
  echo
  echo "=== 5) 按 --no-restart 跳过重启 ==="
  echo "  档案已更新，但运行中的实例仍是旧代码。"
  echo "  **重启请由用户本人执行**（3081 的既定规矩）："
  echo "    Windows 上先 D:\\WSL\\dsh-web.cmd -Stop -Port <端口>，再 D:\\WSL\\dsh-web.cmd -Port <端口>"
  echo "  注意顺序：不先 -Stop，启动器会判定「已有存活实例」直接复用，等于没重启。"
  echo "  另外：装好到重启之间**不要刷新页面** —— 磁盘上是新客户端、内存里是旧宿主，会看到不匹配。"
  echo
  echo "部署完成（未重启）。"
  exit 0
fi

echo "=== 5) 重启（端口 $START_PORT）==="
# 只在目标端口确实是我们自己的 dsh 时才动手；归属不明一律不杀（§12 的既有规矩）。
LISTENER_PID=$(ss -ltnp 2>/dev/null | grep ":$START_PORT " | grep -oE "pid=[0-9]+" | head -1 | cut -d= -f2)
if [ -n "$LISTENER_PID" ]; then
  if ps -o cmd= -p "$LISTENER_PID" 2>/dev/null | grep -q "dsh"; then
    echo "  停掉旧实例 pid=$LISTENER_PID"
    kill -TERM "$LISTENER_PID" 2>/dev/null || true
    sleep 3
    kill -KILL "$LISTENER_PID" 2>/dev/null || true
    sleep 1
  else
    echo "  端口 $START_PORT 被一个非 dsh 进程占用（pid=$LISTENER_PID），不杀归属不明的进程。"; exit 1
  fi
else
  echo "  端口 $START_PORT 当前没有监听，直接启动。"
fi

# setsid 脱壳启动。
# 教训（2026-10-03，0.1.34 那次部署）：原来写的是 nohup ... &，脚本自身在非交互 shell 里
# 跑完后会话结束，子进程被 SIGHUP 带走 —— 现象是「pnpm install 成功、版本已更新、
# 监听也确认过」，但过几十秒实例整个没了，用户看到页面「重新连接中…」。
# 这里自成会话 + 日志重定向到文件，不带在调用者的会话上。
LOG="/mnt/d/WSL/logs/dsh-web-$START_PORT.log"
ERR="/mnt/d/WSL/logs/dsh-web-$START_PORT.err"
URLFILE="/mnt/d/WSL/logs/url-$START_PORT.txt"
setsid bash -c "exec env DSH_HOME='$DSH_HOME_TARGET' /usr/local/bin/dsh web --port $START_PORT --no-open" >"$LOG" 2>"$ERR" < /dev/null &
echo "等待启动（首个模型响应较慢，至少 30 秒）…"
sleep 30

echo "=== 6) 监听确认（两次，间隔 15 秒）==="
# 为什么查两次：0.1.34 那次就是「第一次查还在、几十秒后进程消失」，只查一次会给出假信号。
ss -ltnp 2>/dev/null | grep ":$START_PORT " || { echo "NO LISTENER（首次）"; exit 1; }
sleep 15
ss -ltnp 2>/dev/null | grep ":$START_PORT " || { echo "NO LISTENER（15 秒后掉线，进程被会话带走）"; exit 1; }
echo "  两次都在，进程稳定"

echo "=== 7) 新 token ==="
TOKEN=$(grep -oE "token=[A-Za-z0-9_-]+" "$LOG" | tail -1)
echo "  $TOKEN"
if [ -n "$TOKEN" ]; then echo "http://127.0.0.1:$START_PORT/?$TOKEN" > "$URLFILE"; echo "  已写入 $URLFILE"; fi

echo
echo "部署完成（端口 $START_PORT）。请在浏览器里打开上面的地址验收。"