import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { type JSX, type ReactNode, isValidElement } from 'react';
import SyntaxHighlighter from 'react-syntax-highlighter/dist/esm/prism-light';
import oneDark from 'react-syntax-highlighter/dist/esm/styles/prism/one-dark';
// 按需 import 常用 language（按 reviewer 输出 / 用户对话最高频的语种），bundle 受控。
// 加新语言时这里 register 一次即可，<code className="language-X"> 自动匹配。
import bash from 'refractor/lang/bash';
import css from 'refractor/lang/css';
import diff from 'refractor/lang/diff';
import go from 'refractor/lang/go';
import javascript from 'refractor/lang/javascript';
import json from 'refractor/lang/json';
import jsx from 'refractor/lang/jsx';
import markdown from 'refractor/lang/markdown';
import python from 'refractor/lang/python';
import rust from 'refractor/lang/rust';
import sql from 'refractor/lang/sql';
import toml from 'refractor/lang/toml';
import tsx from 'refractor/lang/tsx';
import typescript from 'refractor/lang/typescript';
import yaml from 'refractor/lang/yaml';

[
  bash,
  css,
  diff,
  go,
  javascript,
  json,
  jsx,
  markdown,
  python,
  rust,
  sql,
  toml,
  tsx,
  typescript,
  yaml,
].forEach((l) => SyntaxHighlighter.registerLanguage((l as unknown as { displayName: string }).displayName, l));
// 常用 alias：sh / shell / zsh → bash；ts → typescript；js → javascript；yml → yaml
SyntaxHighlighter.alias('bash', ['sh', 'shell', 'zsh']);
SyntaxHighlighter.alias('typescript', ['ts']);
SyntaxHighlighter.alias('javascript', ['js']);
SyntaxHighlighter.alias('yaml', ['yml']);

interface Props {
  text: string;
}

/**
 * MessageBubble / TeamDetail messages / ExitPlanMode plan / activity-feed message+thinking
 * 共用的 Markdown 渲染器。
 *
 * 约束：
 * - 仅 GFM（表格 / 任务列表 / 删除线 / 自动链接），不挂 rehype-raw
 *   → react-markdown 默认 escape 原始 HTML，安全
 * - 链接强制 _blank + noopener noreferrer（Electron 里 webContents 默认拦截
 *   target=_blank 并交给系统浏览器，避免在应用窗口里跳转破坏 SPA 路由）
 * - 排版用 Tailwind 类名，控制在 MessageBubble 的窄列宽度内（max-w 88%）
 *   → pre/table 加 overflow-x-auto，避免撑爆气泡
 * - 字号继承气泡的 text-[11px] leading-relaxed，块元素之间留小间距
 *
 * 代码块语法高亮（react-syntax-highlighter prism-light + one-dark）：
 * - block code（` ```ts ... ``` ` 形态，react-markdown v10 把 className="language-ts" 透给
 *   `code`，且 parent 是 `pre`）→ 走 SyntaxHighlighter 按 token 着色
 * - inline code（` \`foo\` ` 形态，无 className 或在 paragraph 内）→ 走原 styled span（rounded
 *   bg + 单色），不开 highlighter（性能 + 视觉简单）
 * - 区分逻辑：判 `code` 元素的 className 是否含 `language-`；含 = block 走 SyntaxHighlighter，
 *   否则走 inline 样式
 */
export function MarkdownText({ text }: Props): JSX.Element {
  return (
    <div className="markdown-bubble">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, ...props }) => (
            <a
              {...props}
              target="_blank"
              rel="noopener noreferrer"
              className="text-status-working underline decoration-status-working/40 hover:decoration-status-working"
            >
              {children}
            </a>
          ),
          code: ({ className, children, ...props }) => {
            const langMatch = /language-(\w+)/.exec(className ?? '');
            if (langMatch) {
              // block code（fenced ```lang）走 SyntaxHighlighter；
              // 注意：react-markdown 把 code 包在 pre 里，下面 pre 组件直接透传 children
              // 避免双重 pre 标签。
              const codeText = String(children).replace(/\n$/, '');
              return (
                <SyntaxHighlighter
                  language={langMatch[1]}
                  style={oneDark}
                  PreTag="div"
                  customStyle={{
                    margin: '0.25rem 0',
                    padding: '0.375rem 0.5rem',
                    borderRadius: '0.25rem',
                    fontSize: '10px',
                    lineHeight: '1.4',
                    background: 'rgba(0, 0, 0, 0.35)',
                  }}
                  codeTagProps={{ style: { fontFamily: 'inherit' } }}
                >
                  {codeText}
                </SyntaxHighlighter>
              );
            }
            // inline code：单色背景，无 syntax 高亮
            return (
              <code
                className="rounded bg-white/10 px-1 font-mono text-[10px]"
                {...props}
              >
                {children}
              </code>
            );
          },
          // pre：检测子节点是否已是 SyntaxHighlighter（block code 路径），是则透传不再包 pre；
          // 仅 inline code 在 pre 内的少见兼容场景包 pre 走原 styled fallback。
          pre: ({ children, ...props }) => {
            // children 通常是单个 code element（react-markdown fenced code 输出形态）；
            // 若 code 已被上面 SyntaxHighlighter 渲染（含 language-X className），children 是
            // SyntaxHighlighter 包好的 div，pre 不再 wrap 避免双 pre 嵌套破坏样式。
            const isHighlighted =
              isValidElement(children) &&
              typeof children.props === 'object' &&
              children.props !== null &&
              hasLanguageClassName((children.props as { className?: unknown }).className);
            if (isHighlighted) {
              return children as ReactNode as JSX.Element;
            }
            return (
              <pre
                {...props}
                className="my-1 overflow-x-auto scrollbar-deck rounded bg-black/30 p-1.5 text-[10px] leading-snug"
              >
                {children}
              </pre>
            );
          },
          table: ({ children, ...props }) => (
            <div className="my-1 overflow-x-auto scrollbar-deck">
              <table {...props} className="text-[10px]">
                {children}
              </table>
            </div>
          ),
          th: ({ children, ...props }) => (
            <th {...props} className="border border-white/15 px-1.5 py-0.5 text-left">
              {children}
            </th>
          ),
          td: ({ children, ...props }) => (
            <td {...props} className="border border-white/10 px-1.5 py-0.5">
              {children}
            </td>
          ),
          ul: ({ children, ...props }) => (
            <ul {...props} className="my-1 list-disc pl-4">
              {children}
            </ul>
          ),
          ol: ({ children, ...props }) => (
            <ol {...props} className="my-1 list-decimal pl-4">
              {children}
            </ol>
          ),
          h1: ({ children, ...props }) => (
            <h1 {...props} className="mt-1 text-[13px] font-semibold">
              {children}
            </h1>
          ),
          h2: ({ children, ...props }) => (
            <h2 {...props} className="mt-1 text-[12px] font-semibold">
              {children}
            </h2>
          ),
          h3: ({ children, ...props }) => (
            <h3 {...props} className="mt-1 text-[11px] font-semibold">
              {children}
            </h3>
          ),
          blockquote: ({ children, ...props }) => (
            <blockquote
              {...props}
              className="my-1 border-l-2 border-white/20 pl-2 text-deck-muted"
            >
              {children}
            </blockquote>
          ),
          p: ({ children, ...props }) => (
            <p {...props} className="my-0.5">
              {children}
            </p>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function hasLanguageClassName(value: unknown): boolean {
  return typeof value === 'string' && /language-/.test(value);
}
