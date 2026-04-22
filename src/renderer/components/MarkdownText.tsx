import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { JSX } from 'react';

interface Props {
  text: string;
}

/**
 * MessageBubble 专用的 Markdown 渲染器。
 *
 * 约束：
 * - 仅 GFM（表格 / 任务列表 / 删除线 / 自动链接），不挂 rehype-raw
 *   → react-markdown 默认 escape 原始 HTML，安全
 * - 链接强制 _blank + noopener noreferrer（Electron 里 webContents 默认拦截
 *   target=_blank 并交给系统浏览器，避免在应用窗口里跳转破坏 SPA 路由）
 * - 排版用 Tailwind 类名，控制在 MessageBubble 的窄列宽度内（max-w 88%）
 *   → pre/table 加 overflow-x-auto，避免撑爆气泡
 * - 字号继承气泡的 text-[11px] leading-relaxed，块元素之间留小间距
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
          // inline code（父级不是 pre）vs block code 的区分由 react-markdown 透传 className 控制：
          // 块级代码块 className 形如 "language-xxx"；这里两者都套底色，靠 pre 父容器决定 overflow
          code: ({ className, children, ...props }) => (
            <code
              className={`rounded bg-white/10 px-1 font-mono text-[10px] ${className ?? ''}`}
              {...props}
            >
              {children}
            </code>
          ),
          pre: ({ children, ...props }) => (
            <pre
              {...props}
              className="my-1 overflow-x-auto scrollbar-deck rounded bg-black/30 p-1.5 text-[10px] leading-snug"
            >
              {children}
            </pre>
          ),
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
