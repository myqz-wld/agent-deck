/**
 * Claude SDK bridge 用到的纯函数 helpers。
 * 之所以独立成文件：保持 sdk-bridge.ts 的 ClaudeSdkBridge class 主体不被无关
 * 字符串拼接函数稀释（class 主体已被多次 review 加固 race / lifecycle 路径）。
 */

import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@shared/types';

/**
 * 把用户在 UI 上对 AskUserQuestion 的选择拼成可读文本，
 * 塞进 SDK 反馈给 Claude 的 deny.message 里。
 */
export function formatAskAnswers(
  questions: AskUserQuestionItem[],
  answer: AskUserQuestionAnswer,
): string {
  const lines: string[] = [];
  const ansByQ = new Map<string, { selected: string[]; other?: string; note?: string }>();
  for (const a of answer.answers ?? []) {
    ansByQ.set(a.question, { selected: a.selected ?? [], other: a.other, note: a.note });
  }
  for (let i = 0; i < questions.length; i += 1) {
    const q = questions[i];
    const a = ansByQ.get(q.question) ?? { selected: [], other: undefined, note: undefined };
    const parts: string[] = [];
    if (a.selected.length > 0) parts.push(a.selected.join(', '));
    if (a.other) parts.push(`其他：${a.other}`);
    const note = a.note?.trim();
    if (note) parts.push(`备注：${note}`);
    lines.push(`Q${i + 1}: ${q.question}\nA: ${parts.length ? parts.join(' | ') : '(未作答)'}`);
  }
  return lines.join('\n\n');
}
