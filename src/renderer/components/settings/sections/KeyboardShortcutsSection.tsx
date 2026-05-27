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
                切换 <strong>置顶</strong>(等价 header 📌 按钮;独立于透明开关)
              </td>
            </tr>
            <tr className="border-b border-deck-border/40">
              <td className="py-1 pr-3 align-top">
                <code className="rounded bg-white/[0.04] px-1.5 py-0.5">{mod}+Alt+T</code>
              </td>
              <td className="py-1 text-deck-muted/80">
                切换 <strong>窗口透明</strong>
                {IS_DARWIN ? (
                  <>(macOS:vibrancy on/off + CSS frosted-frame 主导通透感,看到下层桌面)</>
                ) : (
                  <>(非 macOS:仅影响 CSS 背景透明度,无 vibrancy 效果)</>
                )}
              </td>
            </tr>
            <tr className="border-b border-deck-border/40">
              <td className="py-1 pr-3 align-top">
                <code className="rounded bg-white/[0.04] px-1.5 py-0.5">{mod}+Alt+=</code>
              </td>
              <td className="py-1 text-deck-muted/80">
                一键 <strong>最大化窗口</strong>(到屏幕可用区域;再按回上次手动尺寸)
              </td>
            </tr>
            <tr>
              <td className="py-1 pr-3 align-top">
                <code className="rounded bg-white/[0.04] px-1.5 py-0.5">{mod}+Alt+-</code>
              </td>
              <td className="py-1 text-deck-muted/80">
                一键 <strong>回默认尺寸</strong>(520×680;再按回上次手动尺寸)
              </td>
            </tr>
          </tbody>
        </table>
        <div className="mt-2 text-[10px] text-deck-muted/60 leading-snug">
          全局快捷键 — 应用在前台 / 后台均可触发;被其它 app 占用时启动日志会有 warn 提示。
        </div>
      </div>
    </Section>
  );
}
