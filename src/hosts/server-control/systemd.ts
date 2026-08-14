import { execFileSync } from 'node:child_process';

const SYSTEMCTL = '/usr/bin/systemctl';
const ENVIRONMENT = Object.freeze({
  LANG: 'C',
  LC_ALL: 'C',
  PATH: '/usr/bin:/bin',
});

export interface SystemdControlPort {
  daemonReload(): void;
  enableNow(unit: string): void;
  restart(unit: string): void;
  stopDisable(unit: string): void;
  isActive(unit: string): boolean;
}

function run(args: readonly string[]): void {
  execFileSync(SYSTEMCTL, args, {
    env: ENVIRONMENT,
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: 180_000,
  });
}

export const SYSTEMD_CONTROL: SystemdControlPort = Object.freeze({
  daemonReload: () => run(['daemon-reload']),
  enableNow: (unit) => run(['enable', '--now', unit]),
  restart: (unit) => run(['restart', unit]),
  stopDisable: (unit) => {
    try {
      run(['disable', '--now', unit]);
    } catch {
      run(['stop', unit]);
    }
  },
  isActive: (unit) => {
    try {
      run(['is-active', '--quiet', unit]);
      return true;
    } catch {
      return false;
    }
  },
});
