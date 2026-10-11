/**
 * esbuild 用 loader 把 .css 内联成字符串（见 scripts/build-client.mjs），
 * 这里给 tsc 同样的形状：默认导出一个字符串。
 *
 * 没有这张声明，src/client/entry.ts 里的 `import css from './styles.css'`
 * 就通不过类型检查，主构建配置只能用 exclude 把它排除 —— 后果是 entry.ts
 * 完全脱离类型检查。本文件专供 tsconfig.check.json 使用，主构建配置不受影响。
 */
declare module '*.css' {
  const content: string;
  export default content;
}
