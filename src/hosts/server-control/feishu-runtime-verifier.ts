import { execFileSync } from 'node:child_process';

const FEISHU_WRAPPER = '/opt/agent-deck/bin/agent-deck-feishu';

export interface FeishuRuntimeVerifierPort {
  verifyActive(): void;
}

export const FEISHU_RUNTIME_VERIFIER: FeishuRuntimeVerifierPort = Object.freeze({
  verifyActive: () => {
    execFileSync(FEISHU_WRAPPER, ['check-abi'], {
      env: { LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin' },
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 120_000,
    });
  },
});
