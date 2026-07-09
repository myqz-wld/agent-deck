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
    it('claude-opus-4-8-thinking-max[1m] → opus-4.8（变体后缀全剥）', () => {
      expect(normalizeModel('claude-opus-4-8-thinking-max[1m]')).toEqual({
        bucketKey: 'opus-4.8',
        displayName: 'opus-4.8',
      });
    });

    it('claude-fable-5[1m] → fable-5', () => {
      expect(normalizeModel('claude-fable-5[1m]')).toEqual({
        bucketKey: 'fable-5',
        displayName: 'fable-5',
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

    it('claude-sonnet-4-5 → sonnet-4.5', () => {
      expect(normalizeModel('claude-sonnet-4-5')).toEqual({
        bucketKey: 'sonnet-4.5',
        displayName: 'sonnet-4.5',
      });
    });

    it('claude-haiku-4-5-20251001 → haiku-4.5（日期快照不进入 version）', () => {
      const r = normalizeModel('claude-haiku-4-5-20251001');
      expect(r.bucketKey).toBe('haiku-4.5');
      expect(r.displayName).toBe('haiku-4.5');
    });

    it('claude-sonnet-4-20250514 → sonnet-4（无 minor 的日期快照）', () => {
      expect(normalizeModel('claude-sonnet-4-20250514')).toEqual({
        bucketKey: 'sonnet-4',
        displayName: 'sonnet-4',
      });
    });

    it('claude-opus-4.8-20251001 → opus-4.8（点分隔 version + 日期快照）', () => {
      expect(normalizeModel('claude-opus-4.8-20251001')).toEqual({
        bucketKey: 'opus-4.8',
        displayName: 'opus-4.8',
      });
    });

    it('Claude semantic suffix 保留完整 model identity', () => {
      const variants = [
        'claude-opus-preview',
        'claude-opus-4-8-preview',
        'claude-opus-4-8-bedrock-v2',
        'claude-opus-4-8-20251001-preview',
      ];
      expect(variants.map((model) => normalizeModel(model).bucketKey)).toEqual(variants);
    });

    it('Claude 中间 variant 字样不剥，只有尾部 variant 迭代合并', () => {
      expect(normalizeModel('claude-opus-4-8-thinking-preview').bucketKey).toBe(
        'claude-opus-4-8-thinking-preview',
      );
      expect(normalizeModel('claude-opus-4-8-context[1m]-preview').bucketKey).toBe(
        'claude-opus-4-8-context[1m]-preview',
      );
      expect(normalizeModel('claude-opus-4-8-preview-thinking-max[1m]').bucketKey).toBe(
        'claude-opus-4-8-preview',
      );
    });

    it('大写 / 混合大小写归一', () => {
      expect(normalizeModel('Claude-Opus-4-8').bucketKey).toBe('opus-4.8');
    });

    it('已归一 bucket key 仍按 bucket 风格显示', () => {
      expect(normalizeModel('opus-4.8')).toEqual({
        bucketKey: 'opus-4.8',
        displayName: 'opus-4.8',
      });
      expect(normalizeModel('sonnet-4.5')).toEqual({
        bucketKey: 'sonnet-4.5',
        displayName: 'sonnet-4.5',
      });
    });
  });

  describe('alias（无版本号，agent frontmatter）', () => {
    it.each(['fable', 'opus', 'sonnet', 'haiku'])('%s alias → bucket 风格 family', (alias) => {
      const r = normalizeModel(alias);
      expect(r.bucketKey).toBe(alias);
      expect(r.displayName).toBe(alias);
    });
  });

  describe('gpt / codex', () => {
    it('gpt-5.5 → gpt-5.5（与其他 Codex 模型 bucket 风格对齐）', () => {
      expect(normalizeModel('gpt-5.5')).toEqual({ bucketKey: 'gpt-5.5', displayName: 'gpt-5.5' });
    });

    it('gpt-5-5（连字符分隔）→ gpt-5.5（与点分隔同 bucket/display）', () => {
      expect(normalizeModel('gpt-5-5')).toEqual({ bucketKey: 'gpt-5.5', displayName: 'gpt-5.5' });
    });

    it.each([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.4-mini',
      'gpt-5.3-codex-spark',
      'gpt-5.6-provider-preview',
    ])('%s 保留完整 semantic/provider suffix', (model) => {
      expect(normalizeModel(model)).toEqual({ bucketKey: model, displayName: model });
    });

    it('GPT 尾部 variant 迭代合并，但中间同名字样保留', () => {
      expect(normalizeModel('gpt-5.6-sol-thinking-max[1m]').bucketKey).toBe('gpt-5.6-sol');
      expect(normalizeModel('gpt-5.6-sol-ultra').bucketKey).toBe('gpt-5.6-sol');
      expect(normalizeModel('gpt-5.6-thinking-preview').bucketKey).toBe(
        'gpt-5.6-thinking-preview',
      );
      expect(normalizeModel('gpt-5.6-context[1m]-preview').bucketKey).toBe(
        'gpt-5.6-context[1m]-preview',
      );
      expect(normalizeModel('gpt-5.6-high-throughput').bucketKey).toBe(
        'gpt-5.6-high-throughput',
      );
    });

    it('GPT semantic suffix bucket 小写归一但 displayName 保留原始可读值', () => {
      expect(normalizeModel('  GPT-5.6-SOL  ')).toEqual({
        bucketKey: 'gpt-5.6-sol',
        displayName: 'GPT-5.6-SOL',
      });
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

    it('未知 Claude family / legacy id 不被已知 family 规则截断', () => {
      expect(normalizeModel('claude-mythos-5').bucketKey).toBe('claude-mythos-5');
      expect(normalizeModel('claude-mythos-preview').bucketKey).toBe('claude-mythos-preview');
      expect(normalizeModel('claude-3-5-sonnet-20241022').bucketKey).toBe(
        'claude-3-5-sonnet-20241022',
      );
    });
  });
});

describe('WINDOW_MS', () => {
  it('= 60 秒', () => {
    expect(WINDOW_MS).toBe(60_000);
  });
});
