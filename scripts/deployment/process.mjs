import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const DEFAULT_MAX_OUTPUT = 1024 * 1024;

export async function runCommand(executable, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let settled = false;
    let timedOut = false;

    const collect = (target, chunk) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maxOutputBytes) {
        child.kill('SIGTERM');
        reject(new Error('子进程输出超过安全上限。'));
        settled = true;
        return;
      }
      target.push(chunk);
      if (options.stream === true) {
        (target === stdout ? process.stdout : process.stderr).write(chunk);
      }
    };
    child.stdout.on('data', (chunk) => collect(stdout, chunk));
    child.stderr.on('data', (chunk) => collect(stderr, chunk));
    child.once('error', (error) => {
      if (!settled) reject(error);
      settled = true;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
    }, timeoutMs);
    timer.unref();
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      const result = {
        code: code ?? -1,
        signal,
        timedOut,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      if (timedOut) {
        reject(new Error('子进程执行超时。'));
      } else if (result.code !== 0 && options.allowFailure !== true) {
        const error = new Error(`命令执行失败（exit ${result.code}）。`);
        error.result = result;
        reject(error);
      } else {
        resolve(result);
      }
    });
    if (options.input === undefined) child.stdin.end();
    else child.stdin.end(options.input);
  });
}

export function sshArgs(ssh) {
  return [
    '-o', 'BatchMode=yes',
    '-o', 'IdentitiesOnly=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${ssh.knownHostsFile}`,
    '-o', 'ConnectTimeout=10',
    '-i', ssh.identityFile,
    '-p', String(ssh.port),
  ];
}

export async function runRemoteScript(ssh, scriptPath, args = [], options = {}) {
  const script = await readFile(scriptPath, 'utf8');
  return runCommand(
    ssh.sshBinary,
    [
      ...sshArgs(ssh),
      '--',
      `${ssh.user}@${ssh.host}`,
      '/bin/bash', '-s', '--', ...args,
    ],
    {
      ...options,
      input: script,
      timeoutMs: options.timeoutMs ?? 300_000,
    },
  );
}

export async function uploadFile(ssh, localPath, remotePath, options = {}) {
  return runCommand(
    ssh.scpBinary,
    [
      '-q',
      '-o', 'BatchMode=yes',
      '-o', 'IdentitiesOnly=yes',
      '-o', 'StrictHostKeyChecking=yes',
      '-o', `UserKnownHostsFile=${ssh.knownHostsFile}`,
      '-o', 'ConnectTimeout=10',
      '-i', ssh.identityFile,
      '-P', String(ssh.port),
      '--',
      localPath,
      `${ssh.user}@${ssh.host}:${remotePath}`,
    ],
    { ...options, timeoutMs: options.timeoutMs ?? 300_000 },
  );
}
