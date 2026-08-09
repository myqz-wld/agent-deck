import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const wrappers = [
  'agent-deckd',
  'agent-deck-full-bridge',
  'agent-deck-relay',
  'agent-deck-worker',
] as const;

describe('production Linux wrappers', () => {
  it.each(wrappers)('%s ignores inherited runtime and loader selection', async (name) => {
    const source = await readFile(resolve(process.cwd(), 'resources/bin', name), 'utf8');
    expect(source).toMatch(/^#!\/bin\/bash -p\n/);
    expect(source).toContain(
      'unset AGENT_DECK_HEADLESS_ROOT AGENT_DECK_NODE BASH_ENV ENV',
    );
    expect(source).toContain('LD_LIBRARY_PATH LD_PRELOAD NODE_OPTIONS');
    expect(source).toContain('exec /usr/bin/env -i');
    if (name === 'agent-deck-worker') {
      expect(source).toContain('verify_root_owned_linux /usr/bin/node file');
      expect(source).toContain('verify_root_owned_linux /usr/bin/bwrap file');
      expect(source).toContain('node=/usr/bin/node');
      expect(source).toContain('entrypoint=/opt/agent-deck/linux-headless/local-worker/index.mjs');
      expect(source).toContain('Darwin)');
      expect(source).toContain('configure --credential <Worker凭证> --workspace <目录>');
      expect(source).toContain('{start|status|stop|remove} [--worker <配置标识>]');
      expect(source).toContain('XDG_RUNTIME_DIR=');
      expect(source).toContain('Library/LaunchAgents');
      expect(source).toContain('com.agentdeck.worker-sandbox');
      expect(source).toContain('agent-deck-worker-bookmark');
      expect(source).toContain('Agent Deck Worker CLI');
      expect(source).toContain('Agent Deck Worker Node');
      expect(source).toContain('serve || "$requested_command" == check-runtime');
      expect(source).toContain('--codex-executable "$codex_executable"');
      expect(source).toContain('NODE_PATH="$node_modules"');
      expect(source).toContain('/usr/bin/codesign --verify --strict');
      expect(source).toContain('prepare_sandboxed_node_environment');
      expect(source).toContain('LIFECYCLE_WORKER="$worker"');
      expect(source).toContain('if [[ -n "$LIFECYCLE_WORKER" ]]');
      expect(source).not.toContain('LIFECYCLE_WORKER_ARGS=()');
    } else {
      expect(source).toContain('/usr/bin/node /opt/agent-deck/linux-headless/');
      expect(source).toContain('verify_root_owned /usr/bin/node file');
    }
    expect(source).not.toMatch(/\$\{?AGENT_DECK_(?:HEADLESS_ROOT|NODE)/);
    expect(source).not.toContain('command -v');
    if (name === 'agent-deckd') {
      expect(source).toContain('XDG_STATE_HOME=/var/lib/agent-deck/state');
      expect(source).toContain('XDG_CONFIG_HOME=/var/lib/agent-deck/config');
      expect(source).toContain('XDG_RUNTIME_DIR=/run');
    }
  });
});
