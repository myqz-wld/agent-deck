import { describe, expect, it } from 'vitest';
import {
  normalizeModel,
  WINDOW_MS,
  CLAUDE_DEFAULT_BUCKET,
  CODEX_DEFAULT_BUCKET,
  UNKNOWN_BUCKET,
} from '../model-normalize';

describe('normalizeModel', () => {
  describe('claude 各版本 + 变体合并', () => {
    it('claude-opus-4-8-thinking-max[1m] → Opus 4.8（变体后缀全剥）', () => {
      expect(normalizeModel('claude-opus-4-8-thinking-max[1m]')).toEqual({
        bucketKey: 'opus-4.8',
        displayName: 'Opus 4.8',
      });
    });

    it('claude-fable-5[1m] → Fable 5', () => {
      expect(normalizeModel('claude-fable-5[1m]')).toEqual({
        bucketKey: 'fable-5',
        displayName: 'Fable 5',
      });
    });

    it('同基础模型不同变体合并到同一 bucket', () => {
      const variants = [
        'claude-opus-4-8',
        'claude-opus-4-8-thinking',
        'claude-opus-4-8-thinking-max',
        'claude-opus-4-8-thinking-max[1m]',
        'claude-opus-4-8-1m',
      ];
      const buckets = variants.map((v) => normalizeModel(v).bucketKey);
      expect(new Set(buckets).size).toBe(1);
      expect(buckets[0]).toBe('opus-4.8');
    });

    it('claude-sonnet-4-5 → Sonnet 4.5', () => {
      expect(normalizeModel('claude-sonnet-4-5')).toEqual({
        bucketKey: 'sonnet-4.5',
        displayName: 'Sonnet 4.5',
      });
    });

    it('claude-haiku-4-5-20251001 → Haiku 4.5（日期后缀剥到 version 后停）', () => {
      // major-minor 抓到 4.5 后，-20251001 不被 parse 进 version（regex 只取前两段数字）
      const r = normalizeModel('claude-haiku-4-5-20251001');
      expect(r.bucketKey).toBe('haiku-4.5');
      expect(r.displayName).toBe('Haiku 4.5');
    });

    it('大写 / 混合大小写归一', () => {
      expect(normalizeModel('Claude-Opus-4-8').bucketKey).toBe('opus-4.8');
    });
  });

  describe('alias（无版本号，agent frontmatter）', () => {
    it.each(['fable', 'opus', 'sonnet', 'haiku'])('%s alias → 首字母大写 family', (alias) => {
      const r = normalizeModel(alias);
      expect(r.bucketKey).toBe(alias);
      expect(r.displayName).toBe(alias[0].toUpperCase() + alias.slice(1));
    });
  });

  describe('gpt / codex', () => {
    it('gpt-5.5 → gpt-5.5（与其他 Codex 模型 bucket 风格对齐）', () => {
      expect(normalizeModel('gpt-5.5')).toEqual({ bucketKey: 'gpt-5.5', displayName: 'gpt-5.5' });
    });

    it('gpt-5-5（连字符分隔）→ gpt-5.5（与点分隔同 bucket/display）', () => {
      expect(normalizeModel('gpt-5-5')).toEqual({ bucketKey: 'gpt-5.5', displayName: 'gpt-5.5' });
    });
  });

  describe('占位 / 兜底 bucket', () => {
    it('codex-default 占位 → 「Codex (默认模型)」', () => {
      expect(normalizeModel(CODEX_DEFAULT_BUCKET)).toEqual({
        bucketKey: CODEX_DEFAULT_BUCKET,
        displayName: 'Codex (默认模型)',
      });
    });

    it('claude-default 占位 → 「Claude (默认模型)」', () => {
      expect(normalizeModel(CLAUDE_DEFAULT_BUCKET)).toEqual({
        bucketKey: CLAUDE_DEFAULT_BUCKET,
        displayName: 'Claude (默认模型)',
      });
    });

    it('null → unknown', () => {
      expect(normalizeModel(null)).toEqual({ bucketKey: UNKNOWN_BUCKET, displayName: '未知模型' });
    });

    it('undefined → unknown', () => {
      expect(normalizeModel(undefined).bucketKey).toBe(UNKNOWN_BUCKET);
    });

    it('空串 / 纯空白 → unknown', () => {
      expect(normalizeModel('').bucketKey).toBe(UNKNOWN_BUCKET);
      expect(normalizeModel('   ').bucketKey).toBe(UNKNOWN_BUCKET);
    });
  });

  describe('未识别 model fallback（新模型 / 第三方）', () => {
    it('未识别 → bucketKey 用归一 core，displayName 保原始 raw', () => {
      const r = normalizeModel('some-future-model-v9');
      expect(r.displayName).toBe('some-future-model-v9'); // 保原始可读
      expect(r.bucketKey).toBe('some-future-model-v9'); // 小写归一
    });

    it('未识别但带变体后缀 → 同 model 不同变体仍合并', () => {
      const a = normalizeModel('Mystery-Model-thinking').bucketKey;
      const b = normalizeModel('mystery-model').bucketKey;
      expect(a).toBe(b);
    });
  });
});

describe('WINDOW_MS', () => {
  it('= 60 秒', () => {
    expect(WINDOW_MS).toBe(60_000);
  });
});
