import {
  buildSandboxOptionsCore,
  type SandboxMode,
} from './sandbox-config-core';
import { desktopClaudeSandboxHost } from './sandbox-config-host';

export {
  SANDBOX_EXCLUDED_COMMANDS,
  SANDBOX_MODE_VALUES,
  type SandboxMode,
} from './sandbox-config-core';

export function buildSandboxOptions(
  mode: SandboxMode | undefined,
  cwd: string,
  extraAllowWrite?: readonly string[],
) {
  return buildSandboxOptionsCore(mode, cwd, desktopClaudeSandboxHost, extraAllowWrite);
}
