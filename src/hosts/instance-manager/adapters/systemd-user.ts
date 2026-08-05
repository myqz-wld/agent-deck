import type { CommandPort, SystemdPort, SystemdUnitStatus } from '../types';
import { LinuxHostAdapterError } from './errors';

export interface SystemdUserPortOptions {
  readonly executable?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly maxOutputBytes?: number;
}

const UNIT = /^agent-deck-(?:full|relay)@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.service$/;

function assertUnit(unitName: string): void {
  if (!UNIT.test(unitName)) {
    throw new LinuxHostAdapterError('command_failed', 'systemd unit name was rejected');
  }
}

export class SystemdUserCommandPort implements SystemdPort {
  private readonly executable: string;
  private readonly environment: Readonly<Record<string, string>>;
  private readonly maxOutputBytes: number;

  constructor(
    private readonly commands: CommandPort,
    options: SystemdUserPortOptions = {},
  ) {
    this.executable = options.executable ?? '/usr/bin/systemctl';
    this.environment = options.environment ?? {};
    this.maxOutputBytes = options.maxOutputBytes ?? 64 * 1024;
  }

  private async run(args: readonly string[], timeoutMs: number): Promise<string> {
    const result = await this.commands.run({
      executable: this.executable,
      args,
      timeoutMs,
      maxOutputBytes: this.maxOutputBytes,
      environment: this.environment,
    });
    if (
      result.exitCode !== 0 ||
      result.timedOut ||
      result.outputTruncated ||
      result.stderr !== ''
    ) {
      throw new LinuxHostAdapterError('command_failed', 'systemd user operation failed');
    }
    return result.stdout;
  }

  async daemonReload(timeoutMs: number): Promise<void> {
    const output = await this.run(['--user', 'daemon-reload'], timeoutMs);
    if (output !== '') throw new LinuxHostAdapterError('output_invalid', 'systemd output was unexpected');
  }

  async startUserUnit(unitName: string, timeoutMs: number): Promise<void> {
    assertUnit(unitName);
    const output = await this.run(['--user', 'start', '--', unitName], timeoutMs);
    if (output !== '') throw new LinuxHostAdapterError('output_invalid', 'systemd output was unexpected');
  }

  async stopUserUnit(unitName: string, timeoutMs: number): Promise<void> {
    assertUnit(unitName);
    const output = await this.run(['--user', 'stop', '--', unitName], timeoutMs);
    if (output !== '') throw new LinuxHostAdapterError('output_invalid', 'systemd output was unexpected');
  }

  async statusUserUnit(unitName: string, timeoutMs: number): Promise<SystemdUnitStatus> {
    assertUnit(unitName);
    const output = await this.run([
      '--user',
      'show',
      '--no-pager',
      '--property=Id,FragmentPath,SourcePath,LoadState,ActiveState,SubState',
      '--',
      unitName,
    ], timeoutMs);
    const values = new Map<string, string>();
    for (const line of output.trimEnd().split('\n')) {
      const separator = line.indexOf('=');
      if (separator <= 0) throw new LinuxHostAdapterError('output_invalid', 'systemd status was invalid');
      const key = line.slice(0, separator);
      if (values.has(key)) throw new LinuxHostAdapterError('output_invalid', 'systemd status was duplicate');
      values.set(key, line.slice(separator + 1));
    }
    const expected = ['ActiveState', 'FragmentPath', 'Id', 'LoadState', 'SourcePath', 'SubState'];
    if (expected.some((key) => !values.has(key)) || values.size !== expected.length) {
      throw new LinuxHostAdapterError('output_invalid', 'systemd status was incomplete');
    }
    const loadState = values.get('LoadState');
    const activeState = values.get('ActiveState');
    if (!['loaded', 'not-found', 'error'].includes(String(loadState))) {
      throw new LinuxHostAdapterError('output_invalid', 'systemd load state was invalid');
    }
    if (!['active', 'activating', 'deactivating', 'failed', 'inactive'].includes(String(activeState))) {
      throw new LinuxHostAdapterError('output_invalid', 'systemd active state was invalid');
    }
    return {
      unitName: values.get('Id') as string,
      fragmentPath: values.get('SourcePath') || (values.get('FragmentPath') as string),
      loadState: loadState as SystemdUnitStatus['loadState'],
      activeState: activeState as SystemdUnitStatus['activeState'],
      subState: values.get('SubState') as string,
    };
  }
}
