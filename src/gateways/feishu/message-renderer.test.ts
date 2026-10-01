import { describe, expect, it } from 'vitest';
import { renderFeishuMessage } from './message-renderer';

function richText(text: string): string {
  const result = renderFeishuMessage(text);
  expect(result.messageType).toBe('post');
  const post = JSON.parse(result.content);
  expect(Object.keys(post.zh_cn)).toEqual(['content']);
  expect(post.zh_cn.content).toHaveLength(1);
  expect(post.zh_cn.content[0]).toHaveLength(1);
  expect(post.zh_cn.content[0][0].tag).toBe('md');
  return post.zh_cn.content[0][0].text;
}

describe('ordinary Feishu reply formatting', () => {
  it('keeps simple conversation as plain text without a title or source label', () => {
    expect(renderFeishuMessage('是“星桥”呀。\n目录也核对过了。')).toEqual({
      messageType: 'text', content: JSON.stringify({ text: '是“星桥”呀。\n目录也核对过了。' }),
    });
  });

  it.each([
    '**完成**\n- 第一项\n- 第二项',
    '代码：`pwd`\n\n```sh\npwd\n```',
    '| 名称 | 状态 |\n| --- | --- |\n| 测试 | 完成 |',
    '名称 | 状态\n--- | ---\n测试 | 完成',
    '- [x] 已完成\n- [ ] 待处理',
    '~~旧值~~ 新值',
    '[官方文档](https://example.com/docs?a=1&b=2)',
    '[文档][ref]\n\n[ref]: https://example.com/docs',
  ])('preserves supported Markdown for the native md node: %s', text => {
    expect(richText(text)).toBe(text);
  });

  it('shows complete local paths including spaces, parentheses and code-span delimiters', () => {
    const text = '[工作目录](</workspace/demo (copy)/workdir>)\n[文件](</workspace/a`b.txt>)\n[引用][local]\n\n[local]: /workspace/readme.md';
    const result = richText(text);
    expect(result).toContain('工作目录：`/workspace/demo (copy)/workdir`');
    expect(result).toContain('文件：``/workspace/a`b.txt``');
    expect(result).toContain('引用：`/workspace/readme.md`');
    expect(result).not.toContain('[工作目录](');
  });

  it('does not rewrite link syntax or tags inside inline and fenced code', () => {
    const text = '`[name](/workspace/file)`\n\n```md\n[name](/workspace/file)\n<at user_id="all">everyone</at>\n```';
    expect(richText(text)).toBe(text);
  });

  it('keeps encoded controls visible instead of decoding them into message content', () => {
    const result = richText('[路径](/workspace/a%00%0Ab.txt)');
    expect(result).toBe('路径：`/workspace/a%00%0Ab.txt`');
    expect(result).not.toContain('\u0000');
  });

  it('displays raw mention/HTML tags and image references as text without creating provider entities', () => {
    const text = '<at user_id="all">everyone</at>\n\n![图片](https://example.com/image.png)\n[不执行](javascript:alert(1))';
    const result = richText(text);
    expect(result).not.toMatch(/<at|<\/at|!\[/u);
    expect(result).toContain('＜at user_id="all"＞everyone＜/at＞');
    expect(result).toContain('图片：`https://example.com/image.png`');
    expect(result).toContain('不执行：`javascript:alert(1)`');
  });

  it('rejects oversized encoded rich content locally', () => {
    expect(() => renderFeishuMessage('**中文**'.repeat(4_000)))
      .toThrow(expect.objectContaining({ code: 'delivery_too_large' }));
  });
});
