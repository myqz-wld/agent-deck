import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const macWrapper = readFileSync(resolve('resources/bin/agent-deck'), 'utf8');
const windowsWrapper = readFileSync(resolve('resources/bin/agent-deck.cmd'), 'utf8');

describe('packaged CLI wrapper parity', () => {
  it('keeps provider engineering defaults out of both transport wrappers', () => {
    for (const wrapper of [macWrapper, windowsWrapper]) {
      expect(wrapper).not.toMatch(/HAS_PERMISSION_MODE|TARGET_ADAPTER/);
      expect(wrapper).not.toMatch(/默认\s+bypassPermissions|default\s+bypassPermissions/i);
      expect(wrapper).not.toMatch(/case\s+["']?--(?:permission|approval|.*sandbox|provider|model)/i);
    }
  });

  it('limits wrapper argument behavior to subcommand, cwd normalization, and transport', () => {
    expect(macWrapper).not.toContain('set -- new');
    expect(macWrapper).toContain('if [[ "${1:-}" != "new" ]]');
    expect(macWrapper).toContain('NEW_ARGS+=("--cwd" "$PWD")');
    expect(macWrapper).toContain('agent-deck-argv-b64:');
    expect(windowsWrapper).not.toContain('new --cwd "%CD%"');
    expect(windowsWrapper).toContain('if /I "%FIRST%"=="new"');
    expect(windowsWrapper).toContain('start "" "%APP_EXE%" %*');
  });
});
