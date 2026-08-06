export interface ClaudeSdkRuntimeHost {
  environment(): Readonly<Record<string, string | undefined>>;
  executablePath(): string;
  platform(): string;
  architecture(): string;
  resolveModule(specifier: string): string;
}

export interface ClaudeSdkRuntimeOptions {
  executable: 'node';
  env: Record<string, string>;
}

/** Copy the current process environment and force Electron's executable into Node mode. */
export function getSdkRuntimeOptionsCore(
  host: ClaudeSdkRuntimeHost,
): ClaudeSdkRuntimeOptions {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(host.environment())) {
    if (typeof value === 'string') env[key] = value;
  }
  return {
    // The SDK type is a runtime-name union, but the implementation accepts an absolute executable.
    executable: host.executablePath() as 'node',
    env: {
      ...env,
      ELECTRON_RUN_AS_NODE: '1',
    },
  };
}

function binarySpecifiers(platform: string, architecture: string): string[] {
  const extension = platform === 'win32' ? '.exe' : '';
  const packages = platform === 'linux'
    ? [
        `@anthropic-ai/claude-agent-sdk-linux-${architecture}-musl`,
        `@anthropic-ai/claude-agent-sdk-linux-${architecture}`,
      ]
    : [`@anthropic-ai/claude-agent-sdk-${platform}-${architecture}`];
  return packages.map((packageName) => `${packageName}/claude${extension}`);
}

/** Rewrite only a complete app.asar path segment, leaving dev and already-unpacked paths intact. */
export function unpackClaudeSdkBinaryPathCore(path: string): string {
  return path.replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
}

/** Resolve the platform SDK binary using Claude's musl-first order and fail back to SDK discovery. */
export function getPathToClaudeCodeExecutableCore(
  host: ClaudeSdkRuntimeHost,
): string | undefined {
  for (const specifier of binarySpecifiers(host.platform(), host.architecture())) {
    try {
      return unpackClaudeSdkBinaryPathCore(host.resolveModule(specifier));
    } catch {
      // The current package can be absent in development or a platform-specific packaged build.
    }
  }
  return undefined;
}
