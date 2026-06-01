/**
 * SessionDetail helpers 纯逻辑单测（deep-review H3 回归兜底）。
 *
 * 覆盖 decodeBlob / fileKindLabel + 本批新增 groupFileChanges / pickLatestChange
 * （同毫秒同文件改动 id tiebreaker —— H3 LOW，旧实现仅按 ts 选最新会选到旧 row）。
 */
import { describe, expect, it } from 'vitest';
import {
  decodeBlob,
  fileKindLabel,
  groupFileChanges,
  pickLatestChange,
  type FileChangeLike,
} from '../helpers';

const c = (id: number, filePath: string, ts: number): FileChangeLike => ({ id, filePath, ts });

describe('decodeBlob', () => {
  it('image kind → JSON.parse', () => {
    expect(decodeBlob('image', '{"src":"x"}')).toEqual({ src: 'x' });
  });
  it('image kind 非法 JSON → null', () => {
    expect(decodeBlob('image', 'not-json')).toBeNull();
  });
  it('blob null → null', () => {
    expect(decodeBlob('text', null)).toBeNull();
  });
  it('text kind → 原样返回', () => {
    expect(decodeBlob('text', 'hello')).toBe('hello');
  });
});

describe('fileKindLabel', () => {
  it('已知 kind → 中文', () => {
    expect(fileKindLabel('text')).toBe('文本');
    expect(fileKindLabel('image')).toBe('图片');
  });
  it('未知 kind → 大写', () => {
    expect(fileKindLabel('xyz')).toBe('XYZ');
  });
});

describe('pickLatestChange — 同毫秒按 id tiebreaker（deep-review H3 LOW）', () => {
  it('空列表 → null', () => {
    expect(pickLatestChange([])).toBeNull();
  });
  it('不同 ts → 取 ts 最大', () => {
    expect(pickLatestChange([c(1, 'a', 100), c(2, 'a', 300), c(3, 'a', 200)])?.id).toBe(2);
  });
  it('同毫秒 → 取 id 最大（真最新，旧实现会选到旧 row）', () => {
    // 两条同 ts=100，id 5 是更新的那条
    expect(pickLatestChange([c(3, 'a', 100), c(5, 'a', 100), c(4, 'a', 100)])?.id).toBe(5);
  });
});

describe('groupFileChanges — 分组 + 组内升序 + 组间倒序 + id tiebreaker', () => {
  it('按 filePath 分组，组内升序（旧→新）', () => {
    const groups = groupFileChanges([c(1, 'a', 200), c(2, 'a', 100), c(3, 'b', 150)]);
    const a = groups.find((g) => g.filePath === 'a');
    expect(a?.items.map((i) => i.id)).toEqual([2, 1]); // ts 100 在前，200 在后
  });
  it('组内同毫秒按 id 升序 → items[last] 真为最新', () => {
    const groups = groupFileChanges([c(5, 'a', 100), c(3, 'a', 100), c(4, 'a', 100)]);
    const a = groups.find((g) => g.filePath === 'a');
    expect(a?.items.map((i) => i.id)).toEqual([3, 4, 5]); // 升序
    expect(a?.items[a.items.length - 1].id).toBe(5); // 最新是 id 5 不是旧 row
  });
  it('文件按最近改动倒序（lastTs DESC，同 ts 按 lastId DESC）', () => {
    // 文件 a 最近 ts=300，文件 b 最近 ts=300（同），a 的 lastId=10 > b 的 lastId=9
    const groups = groupFileChanges([c(1, 'a', 100), c(10, 'a', 300), c(9, 'b', 300)]);
    expect(groups.map((g) => g.filePath)).toEqual(['a', 'b']); // a 在前（lastId 10 > 9）
  });
});
