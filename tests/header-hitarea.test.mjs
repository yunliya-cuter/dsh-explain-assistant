import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

/**
 * 标题栏按钮必须能点得到。
 *
 * 真页面上实测到过的一个缺陷（2026-10，420px 宽浮窗）：
 * 关闭按钮「×」的中心被右上角那个 24×24 的 NE 拖拽热区压住 ——
 * 点「关闭」变成了"开始拖拽改大小"，窗关不掉，用户会以为界面卡死。
 *
 * 八个热区是绝对定位且排在标题栏之后（DOM 顺序在最后），所以不显式抬高层级，
 * 它们一定盖在按钮上面。这条测试钉的就是那个层级关系，防止将来有人把它删掉。
 */
test('标题栏按钮组的层级必须高于八个 resize 热区', async () => {
  const raw = await readFile(new URL('../src/client/styles.css', import.meta.url), 'utf8');
  // 先剥注释：注释里也会出现 "z-index:3" 这种字样，直接正则会把它们当成声明（踩过一次）。
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, '');
  const zoneRule = css.match(/\.ea-resize-edge\{[^}]*\}/);
  assert.ok(zoneRule, '必须有 resize 热区样式');
  const zoneZ = /z-index:\s*(\d+)/.exec(zoneRule[0]);
  assert.ok(zoneZ, 'resize 热区必须声明 z-index');
  const actionsRule = css.match(/\.ea-header-actions\{[^}]*\}/);
  assert.ok(actionsRule, '必须有标题栏按钮组样式');
  const actionsZ = /z-index:\s*(\d+)/.exec(actionsRule[0]);
  assert.ok(actionsZ, '标题栏按钮组必须声明 z-index（否则会被热区盖住）');
  assert.ok(Number(actionsZ[1]) > Number(zoneZ[1]), '按钮组的 z-index 必须高于热区，实际：' + actionsZ[1] + ' vs ' + zoneZ[1]);
});
