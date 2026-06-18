import { createContext, useContext } from 'react';

/**
 * 标记当前 diff viewer 是否处于放大展开模式。
 * 放大模式下，TextDiffRenderer 等渲染器会隐藏内部 DiffHeader（路径已在外层放大 header 显示）。
 */
const Ctx = createContext(false);

export const ExpandedProvider = Ctx.Provider;

export function useDiffExpanded(): boolean {
  return useContext(Ctx);
}
