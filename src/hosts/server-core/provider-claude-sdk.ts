import * as bundledClaudeSdk from '@anthropic-ai/claude-agent-sdk';

/** Headless runtimes are loaded from a sealed file descriptor, so provider SDKs stay bundled. */
export async function loadServerCoreClaudeSdk(): Promise<typeof bundledClaudeSdk> {
  return bundledClaudeSdk;
}
