import { describe, expect, it, vi } from 'vitest';
import {
  assertClaudeGatewayForkTranscriptRootCompatibleCore,
  type ClaudeGatewayForkSafetyHost,
} from './gateway-fork-safety-core';

function makeHost(gatewayRoot: string): ClaudeGatewayForkSafetyHost {
  return {
    getMainConfigRoot: vi.fn(() => '/main-root'),
    resolveGatewayProfile: vi.fn(() => ({ id: 'deepseek', configRoot: gatewayRoot })),
    canonicalizeConfigRoot: vi.fn((root) => root),
  };
}

describe('Claude Gateway fork safety Core', () => {
  it('accepts equal canonical transcript roots', () => {
    expect(() =>
      assertClaudeGatewayForkTranscriptRootCompatibleCore(
        'deepseek',
        { gatewaysDir: '/gateways' },
        {},
        makeHost('/main-root'),
      ),
    ).not.toThrow();
  });

  it('rejects a mismatched transcript root with the existing recovery direction', () => {
    expect(() =>
      assertClaudeGatewayForkTranscriptRootCompatibleCore(
        'deepseek',
        { gatewaysDir: '/gateways' },
        {},
        makeHost('/gateway-root'),
      ),
    ).toThrow(
      /Gateway profile "deepseek".*differs from the main-process Claude transcript root.*contextMode "fresh"/,
    );
  });
});
