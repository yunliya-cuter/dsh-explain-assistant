import { build } from 'esbuild';

await build({
  entryPoints: ['src/client/entry.ts'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  // esbuild 默认把中文转义成 \\uXXXX，产物没法用 grep 核对、出问题也难排查。
  // 显式输出 UTF-8，让「产物里到底有没有这句中文」变成可核验的事实。
  charset: 'utf8',
  external: ['react'],
  loader: { '.css': 'text' },
  banner: { js: 'window.__ModuleLoader__.load({id:"dsh-explain-assistant",factory:(require)=>{var module={exports:{}};var exports=module.exports;' },
  footer: { js: 'return module.exports;}});' },
});
