/**
 * Renderer-side ambient module declarations.
 *
 * `refractor/lang/*` 的 .d.ts 文件存在但 TS moduleResolution=node 下走 pnpm strict
 * isolation（refractor 仅作为 react-syntax-highlighter 的传递依赖，不暴露在顶层
 * node_modules，subpath conditional exports `./*` 在 TS node mode 下解析不可靠）。
 * 部分 lang（bash/css/diff/go/javascript/json）能找到、部分（jsx/markdown/python/...
 * 等）找不到 —— 行为不确定。运行时 Vite ESM 解析能正确找到 `.pnpm/node_modules/
 * refractor/lang/*.js`，所以只是 TS 静态检查需要 ambient declare 兜底。
 *
 * 加新 lang 不需要改这里，自动匹配。
 */
declare module 'refractor/lang/*' {
  const lang: {
    displayName: string;
    aliases: string[] | unknown[];
    (Prism: unknown): void;
  };
  export default lang;
}
