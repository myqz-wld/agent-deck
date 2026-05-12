/**
 * Renderer-side ambient module declarations.
 *
 * refractor v5 把 `package.json` 的 `exports` 字段改成 `"./*": "./lang/*.js"`，
 * 正确 import 形态是 `refractor/<lang>`（不再是 v3 的 `refractor/lang/<lang>`）。
 * 但 TS `moduleResolution: "node"` 不识别 conditional exports，会给所有
 * subpath import 报 TS2307；运行时 Vite/rollup 各有原生 exports 解析能找到
 * `.pnpm/refractor@5.0.0/node_modules/refractor/lang/<lang>.js`，所以只是
 * TS 静态检查需要 ambient declare 兜底。
 *
 * 加新 lang 不需要改这里，自动匹配。
 */
declare module 'refractor/*' {
  const lang: {
    displayName: string;
    aliases: string[] | unknown[];
    (Prism: unknown): void;
  };
  export default lang;
}
