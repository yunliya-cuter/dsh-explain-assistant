#!/bin/bash
# 一键部署 dsh-explain-assistant 到 3082 运行时。
#
# 为什么需要你在自己的终端里跑：这条链要写会话工作区之外的 DSH profile 目录
# （/home/dsh/.dsh/profiles/web）与日志目录（/mnt/d/WSL/logs），
# agent 的文件沙箱（workspace-write）不允许，提权也被自动复核拒绝。
#
# 用法：  bash /mnt/d/projects/dsh-explain-assistant/scripts/deploy-3082.sh 0.1.24
set -e

VERSION="${1:?用法: deploy-3082.sh <version>，例如 0.1.24}"
REPO=/mnt/d/projects/dsh-explain-assistant
PROFILE=/home/dsh/.dsh/profiles/web
TGZ="$REPO/dsh-explain-assistant-$VERSION.tgz"

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
    c=$(grep -c -- "$needle" "$f" 2>/dev/null || true)
    n=$((n + ${c:-0}))
  done
  echo "  $needle -> $n"
  if [ "$n" -eq 0 ]; then echo "  ✗ 缺少标记「$needle」：装上的产物不是本次构建，部署中止。"; exit 1; fi
}
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

echo "=== 5) 重启 3082 ==="
bash /tmp/kill3082.sh 3082 || true
sleep 3
# 用 setsid 脱壳启动。
# 教训（2026-10-03，0.1.34 那次部署）：原来这里写的是 `nohup bash /tmp/start3082.sh &`，
# 脚本自身在非交互 shell 里跑完后会话结束，子进程被 SIGHUP 带走 ——
# 现象是「pnpm install 成功、版本已更新、监听也确认过」，但过几十秒 3082 整个没了，
# 用户看到页面「重新连接中…」。3081 的启动器 dsh-web-detach.sh 注释里已经记过这个坑，
# 这里照同样的办法处理：自成会话 + 日志重定向到文件，不带在调用者的会话上。
setsid bash /tmp/start3082.sh >/dev/null 2>&1 < /dev/null &
echo "等待启动（首个模型响应较慢，至少 30 秒）…"
sleep 30

echo "=== 6) 监听确认（两次，间隔 15 秒）==="
# 为什么查两次：0.1.34 那次部署就是"第一次查还在、几十秒后进程消失"，
# 只查一次会给出"部署成功"的假信号。第二次仍活着才算真的起来了。
ss -ltnp 2>/dev/null | grep 3082 || { echo 'NO LISTENER（首次）'; exit 1; }
sleep 15
ss -ltnp 2>/dev/null | grep 3082 || { echo 'NO LISTENER（15 秒后掉线，进程被会话带走）'; exit 1; }
echo '  两次都在，进程稳定'

echo "=== 7) 新 token ==="
grep -oE 'token=[A-Za-z0-9_-]+' /mnt/d/WSL/logs/t3082.log | tail -1

echo
echo "部署完成。请在 Chrome 里刷新 3082 页面后再验收。"
