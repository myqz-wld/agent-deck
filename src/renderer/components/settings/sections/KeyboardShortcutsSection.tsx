import { type JSX } from 'react';
import { Section } from '../controls';
import { IS_DARWIN } from '@renderer/lib/platform';

/**
 * 「快捷键」section — 集中列全局快捷键 (CHANGELOG_124 4 个 globalShortcut + 后续新增)。
 * 抽自 WindowSection 内嵌的「快捷键速查」段;让快捷键说明独立成 section + 与"窗口"
 * 设置组并列展示,user 找快捷键不必先打开"窗口"折叠面板。
 *
 * SSOT 注:实际 globalShortcut.register 在 src/main/index.ts §10 起 4 个段;本 section
 * 仅 doc 用 — 改快捷键时同步更新 src/main/index.ts + 本文件。
 */
export function KeyboardShortcutsSection(): JSX.Element {
  const mod = IS_DARWIN ? 'Cmd' : 'Ctrl';
  return (
    <Section title="快捷键" storageKey="keyboard-shortcuts" defaultOpen={false}>
      <div className="text-[11px] leading-snug">
        <table className="w-full border-collapse">
          <tbody>
            <tr className="border-b border-deck-border/40">
              <td className="py-1 pr-3 align-top">
                <code className="rounded bg-white/[0.04] px-1.5 py-0.5">{mod}+Alt+P</code>
              </td>
              <td className="py-1 text-deck-muted/80">
                切换<strong>窗口置顶</strong>
              </td>
            </tr>
            <tr className="border-b border-deck-border/40">
              <td className="py-1 pr-3 align-top">
                <code className="rounded bg-white/[0.04] px-1.5 py-0.5">{mod}+Alt+T</code>
              </td>
              <td className="py-1 text-deck-muted/80">
                切换<strong>窗口透明</strong>
                {IS_DARWIN ? (
                  <>（macOS 下切换半透明毛玻璃效果，可看到下方桌面）</>
                ) : (
                  <>（非 macOS 下只调整窗口背景透明度）</>
                )}
              </td>
            </tr>
            <tr className="border-b border-deck-border/40">
              <td className="py-1 pr-3 align-top">
                <code className="rounded bg-white/[0.04] px-1.5 py-0.5">{mod}+Alt+=</code>
              </td>
              <td className="py-1 text-deck-muted/80">
                <strong>最大化窗口</strong>；再按一次恢复上次尺寸
              </td>
            </tr>
            <tr>
              <td className="py-1 pr-3 align-top">
                <code className="rounded bg-white/[0.04] px-1.5 py-0.5">{mod}+Alt+-</code>
              </td>
              <td className="py-1 text-deck-muted/80">
                <strong>恢复默认尺寸</strong>（520×680）；再按一次恢复上次尺寸
              </td>
            </tr>
          </tbody>
        </table>
        <div className="mt-2 text-[10px] text-deck-muted/60 leading-snug">
          应用在前台或后台都可使用。若快捷键被其他应用占用，请查看启动日志。
        </div>
      </div>
    </Section>
  );
}
