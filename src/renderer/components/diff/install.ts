import { diffRegistry } from './registry';
import { TextDiffRenderer } from './renderers/TextDiffRenderer';
import { ImageDiffRenderer } from './renderers/ImageDiffRenderer';
import { PdfDiffRenderer } from './renderers/PdfDiffRenderer';
import type { DiffPayload } from '@shared/types';

/**
 * 在应用启动时调用一次。把首期内置的几个 renderer 注册进 DiffRegistry。
 * 第三方/未来插件可以模仿同样的方式追加。
 */
export function registerBuiltinDiffRenderers(): void {
  diffRegistry.register({
    kind: 'text',
    priority: 0,
    canHandle: (p: DiffPayload) => p.kind === 'text',
    Component: TextDiffRenderer,
  });
  diffRegistry.register({
    kind: 'image',
    priority: 0,
    canHandle: (p: DiffPayload) => p.kind === 'image',
    Component: ImageDiffRenderer,
  });
  diffRegistry.register({
    kind: 'pdf',
    priority: 0,
    canHandle: (p: DiffPayload) => p.kind === 'pdf',
    Component: PdfDiffRenderer,
  });
}
