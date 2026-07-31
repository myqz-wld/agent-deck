/** Side-effect-free bounded Codex config reader tests. */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  readTopLevelModelFromCodexConfig,
  readTopLevelModelReasoningEffortFromCodexConfig,
} from '../toml-writer';

function makeTmp(): string {
  return join(mkdtempSync(join(tmpdir(), 'codex-toml-')), 'config.toml');
}

// plan model-token-stats-and-dashboard-20260602 §Phase 1 A4c / deep-review R2 G1 + R3 LOW-1
describe('readTopLevelModelFromCodexConfig (section-aware)', () => {
  function writeConfig(content: string): string {
    const path = makeTmp();
    writeFileSync(path, content, 'utf8');
    return path;
  }

  it('顶层 model 在第一个 [section] 前 → 取值', () => {
    const path = writeConfig(
      'model = "gpt-5.5"\nmodel_provider = "xaminim"\n\n[model_providers.xaminim]\nname = "OpenRouter"\n',
    );
    expect(readTopLevelModelFromCodexConfig(path)).toBe('gpt-5.5');
  });

  it('无顶层 model 但 [profiles.foo] 段内有 model → 返 null（section-aware 不误读）', () => {
    const path = writeConfig('model_provider = "x"\n\n[profiles.foo]\nmodel = "gpt-x"\n');
    expect(readTopLevelModelFromCodexConfig(path)).toBeNull();
  });

  it('model_provider 不被误命中（精确锚 model 后紧跟 =）', () => {
    const path = writeConfig('model_provider = "xaminim"\n[model_providers.q]\nname = "x"\n');
    expect(readTopLevelModelFromCodexConfig(path)).toBeNull();
  });

  it('# model= 注释行不命中', () => {
    const path = writeConfig('# model = "commented"\nmodel_provider = "x"\n');
    expect(readTopLevelModelFromCodexConfig(path)).toBeNull();
  });

  it('inline comment：model = "x" # primary → 取 x（R3 LOW-1）', () => {
    const path = writeConfig('model = "gpt-5.5" # primary model\n[s]\n');
    expect(readTopLevelModelFromCodexConfig(path)).toBe('gpt-5.5');
  });

  it('literal 单引号：model = \'x\' → 取 x（R3 LOW-1）', () => {
    const path = writeConfig("model = 'gpt-5.5'\n[s]\n");
    expect(readTopLevelModelFromCodexConfig(path)).toBe('gpt-5.5');
  });

  it('hash-in-value：model = "gpt#5.5" 不被 inline comment 误截', () => {
    const path = writeConfig('model = "gpt#5.5"\n');
    expect(readTopLevelModelFromCodexConfig(path)).toBe('gpt#5.5');
  });

  it('文件不存在 → null', () => {
    expect(readTopLevelModelFromCodexConfig('/nonexistent/path/config.toml')).toBeNull();
  });

  it('空文件 → null', () => {
    expect(readTopLevelModelFromCodexConfig(writeConfig(''))).toBeNull();
  });
});

describe('readTopLevelModelReasoningEffortFromCodexConfig', () => {
  function writeConfig(content: string): string {
    const path = makeTmp();
    writeFileSync(path, content, 'utf8');
    return path;
  }

  it.each(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const)(
    'reads supported top-level effort %s',
    (effort) => {
      const path = writeConfig(
        `model = "gpt-5.6-sol"\nmodel_reasoning_effort = "${effort}"\n[profiles.fast]\nmodel_reasoning_effort = "low"\n`,
      );
      const before = readFileSync(path, 'utf8');
      expect(readTopLevelModelReasoningEffortFromCodexConfig(path)).toBe(effort);
      expect(readFileSync(path, 'utf8')).toBe(before);
    },
  );

  it('does not accept removed minimal as a configured top-level effort', () => {
    expect(
      readTopLevelModelReasoningEffortFromCodexConfig(
        writeConfig('model_reasoning_effort = "minimal"\n'),
      ),
    ).toBeNull();
  });

  it('supports a literal string and ignores inline comments', () => {
    const path = writeConfig("model_reasoning_effort = 'max' # current default\n");
    expect(readTopLevelModelReasoningEffortFromCodexConfig(path)).toBe('max');
  });

  it('does not read a profile-local effort', () => {
    const path = writeConfig('[profiles.fast]\nmodel_reasoning_effort = "ultra"\n');
    expect(readTopLevelModelReasoningEffortFromCodexConfig(path)).toBeNull();
  });

  it('stays unset when an active profile could override the top-level effort', () => {
    const path = writeConfig(
      'profile = "fast"\nmodel_reasoning_effort = "high"\n' +
        '[profiles.fast]\nmodel_reasoning_effort = "ultra"\n',
    );
    expect(readTopLevelModelReasoningEffortFromCodexConfig(path)).toBeNull();
  });

  it('leaves unknown future or unquoted values provider-owned', () => {
    expect(
      readTopLevelModelReasoningEffortFromCodexConfig(
        writeConfig('model_reasoning_effort = "future"\n'),
      ),
    ).toBeNull();
    expect(
      readTopLevelModelReasoningEffortFromCodexConfig(
        writeConfig('model_reasoning_effort = ultra\n'),
      ),
    ).toBeNull();
  });
});
