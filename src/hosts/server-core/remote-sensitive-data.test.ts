import { describe, expect, it } from 'vitest';

import {
  isRemoteSensitiveAssetPath,
  isRemoteSensitiveKey,
  isRemoteSensitiveWorkspacePath,
  redactRemoteSensitiveText,
  REMOTE_SENSITIVE_OMISSION,
} from './remote-sensitive-data';

describe('Remote sensitive presentation policy', () => {
  it('denies provider configuration, credentials, keys and encoded traversal-shaped names', () => {
    for (const path of [
      'repo/.claude/settings.json',
      'repo/.CODEX/config.toml',
      'repo/.grok/auth.json',
      'repo/.ssh/id_ed25519',
      'repo/.env.production',
      'repo/credentials.json',
      'repo/worker.agentdeck-connection',
      'repo/%2e%2e/.claude/settings.json',
    ]) expect(isRemoteSensitiveWorkspacePath(path)).toBe(true);
    expect(isRemoteSensitiveWorkspacePath('repo/src/config.ts')).toBe(false);
  });

  it('keeps legitimate asset namespaces while denying sensitive asset leaves', () => {
    expect(isRemoteSensitiveAssetPath('/home/provider/.codex/agents/reviewer.toml')).toBe(false);
    expect(isRemoteSensitiveAssetPath('/home/provider/.claude/skills/review/SKILL.md')).toBe(false);
    expect(isRemoteSensitiveAssetPath('/home/provider/.codex/auth.json')).toBe(true);
    expect(isRemoteSensitiveAssetPath('/home/provider/plugin/private-key.pem')).toBe(true);
  });

  it('redacts deceptive secret keys and values without treating token counts as credentials', () => {
    expect(isRemoteSensitiveKey('credentialLocationHint')).toBe(true);
    expect(isRemoteSensitiveKey('apiToken')).toBe(true);
    expect(isRemoteSensitiveKey('access_key')).toBe(true);
    expect(isRemoteSensitiveKey('awsAccessKeyId')).toBe(true);
    expect(isRemoteSensitiveKey('providerAccessKey')).toBe(true);
    expect(isRemoteSensitiveKey('reasoningTokens')).toBe(false);
    const text = [
      'apiToken=sk-secretmarker123',
      'Authorization: Bearer abcdefghijklmnop',
      'jwt=eyJabcdefghi.abcdefghijkl.abcdefghijkl',
      '-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----',
      'please inspect .codex/auth.json and .claude/settings.json',
    ].join('\n');
    const redacted = redactRemoteSensitiveText(text);
    expect(redacted).not.toContain('secretmarker');
    expect(redacted).not.toContain('abcdefghijkl');
    expect(redacted).not.toContain('PRIVATE KEY');
    expect(redacted).not.toContain('.codex');
    expect(redacted).not.toContain('.claude');
    expect(redacted).toContain(REMOTE_SENSITIVE_OMISSION);
  });

  it('redacts provider-prefixed and generic high-entropy credentials as whole values', () => {
    const aws = 'AKIAIOSFODNN7EXAMPLE';
    const github = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcd';
    const groq = 'gsk_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcd';
    const huggingFace = 'hf_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcd';
    const google = 'AIzaABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abc';
    const opaque = 'aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW1xY3zA5cD7eF9gH2jK4';
    const redacted = redactRemoteSensitiveText([
      `aws=${aws}`,
      `github=${github}`,
      `groq=${groq}`,
      `huggingFace=${huggingFace}`,
      `google=${google}`,
      `opaque ${opaque}`,
      `access_key=${opaque}`,
    ].join('\n'));

    for (const secret of [aws, github, groq, huggingFace, google, opaque]) {
      expect(redacted).not.toContain(secret);
      expect(redacted).not.toContain(secret.slice(-12));
    }
    expect(redacted.match(/\[敏感内容已省略\]/gu)?.length).toBeGreaterThanOrEqual(7);
  });

  it('projects host paths in ordinary strings through the caller policy', () => {
    expect(redactRemoteSensitiveText(
      'cache=/opt/worker/private custom=/mnt/runtime-x/socket/state.json output=/api/v1',
      () => '[private]',
    )).toBe('cache=[private] custom=[private] output=[private]');
    expect(redactRemoteSensitiveText(
      'volume="/Volumes/Worker X/私有/config.json"',
    )).toBe(`volume="${REMOTE_SENSITIVE_OMISSION}"`);
    expect(redactRemoteSensitiveText('mount=/custom-private-root'))
      .toBe(`mount=${REMOTE_SENSITIVE_OMISSION}`);
    expect(redactRemoteSensitiveText('路径：/自定义/私有/配置.json'))
      .toBe(`路径：${REMOTE_SENSITIVE_OMISSION}`);
  });
});
