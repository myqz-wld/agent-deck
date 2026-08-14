import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, lstatSync, unlinkSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import type { JsonValue } from '@contracts/index';
import { FeishuGatewayError, type EnrolledFeishuCredential } from '@gateways/im';
import type {
  FeishuConnectionHealth,
  FeishuPairingStore,
  FeishuProductionTopology,
} from '@gateways/feishu';
import {
  FEISHU_MANAGEMENT_MAX_LINE_BYTES,
  parseFeishuManagementRequest,
  type FeishuManagementRequest,
  type FeishuManagementResponse,
} from '@shared/feishu-management';

const CODE_LIFETIME_MS = 10 * 60 * 1_000;
const REQUEST_TIMEOUT_MS = 3_000;

export interface FeishuManagementTarget extends FeishuPairingStore {
  listActiveCredentials(): readonly EnrolledFeishuCredential[];
  getHealth(instanceId: string): FeishuConnectionHealth | null;
}

export interface FeishuManagementServerOptions {
  socketPath: string;
  instanceId: string;
  topology: FeishuProductionTopology;
  target: FeishuManagementTarget;
  coreStatus(): JsonValue;
  verifyCore(): Promise<JsonValue>;
  now(): number;
  onFatal(code: string): void;
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function response(
  id: string,
  result: unknown,
): FeishuManagementResponse {
  return { schemaVersion: 1, id, ok: true, result: result as never };
}

function failure(id: string, code: string): FeishuManagementResponse {
  return {
    schemaVersion: 1,
    id,
    ok: false,
    error: { code, message: '飞书本机管理请求未完成。' },
  };
}

function removeOwnedSocket(path: string): void {
  try {
    const metadata = lstatSync(path);
    if (!metadata.isSocket() || metadata.isSymbolicLink() || metadata.uid !== process.geteuid?.()) {
      throw new Error('untrusted');
    }
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new FeishuGatewayError(
        'invalid_configuration',
        'Feishu management socket path is not trusted',
      );
    }
  }
}

export class FeishuManagementServer {
  private server: Server | null = null;

  constructor(private readonly options: FeishuManagementServerOptions) {}

  async start(): Promise<void> {
    if (this.server) throw new Error('Feishu management server is already started');
    removeOwnedSocket(this.options.socketPath);
    const server = createServer((socket) => this.accept(socket));
    server.maxConnections = 8;
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(this.options.socketPath);
    });
    try {
      chmodSync(this.options.socketPath, 0o600);
      const metadata = lstatSync(this.options.socketPath);
      if (
        !metadata.isSocket() || metadata.isSymbolicLink() ||
        metadata.uid !== process.geteuid?.() || (metadata.mode & 0o777) !== 0o600
      ) throw new Error('untrusted');
    } catch (error) {
      await this.close();
      throw new FeishuGatewayError(
        'invalid_configuration',
        'Feishu management socket permissions could not be verified',
        false,
        undefined,
        { cause: error },
      );
    }
    server.on('error', () => this.options.onFatal('management-socket-failed'));
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    removeOwnedSocket(this.options.socketPath);
  }

  private accept(socket: Socket): void {
    let bytes = Buffer.alloc(0);
    let handled = false;
    socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy());
    socket.on('data', (chunk: Buffer) => {
      if (handled) return;
      bytes = Buffer.concat([bytes, chunk], bytes.length + chunk.length);
      if (bytes.length > FEISHU_MANAGEMENT_MAX_LINE_BYTES) {
        handled = true;
        this.write(socket, failure('invalid', 'request_too_large'));
        return;
      }
      const newline = bytes.indexOf(0x0a);
      if (newline < 0) return;
      handled = true;
      if (bytes.subarray(newline + 1).toString('utf8').trim().length > 0) {
        this.write(socket, failure('invalid', 'invalid_request'));
        return;
      }
      void this.handleLine(socket, bytes.subarray(0, newline));
    });
    socket.on('error', () => undefined);
  }

  private async handleLine(socket: Socket, line: Buffer): Promise<void> {
    let request: FeishuManagementRequest;
    try {
      request = parseFeishuManagementRequest(JSON.parse(line.toString('utf8')));
    } catch {
      this.write(socket, failure('invalid', 'invalid_request'));
      return;
    } finally {
      line.fill(0);
    }
    try {
      this.write(socket, await this.execute(request));
    } catch (error) {
      const code = error instanceof FeishuGatewayError ? error.code : 'internal_error';
      this.write(socket, failure(request.id, code));
    }
  }

  private execute(request: FeishuManagementRequest): Promise<FeishuManagementResponse> {
    const now = this.options.now();
    if (request.method === 'status') {
      const active = this.options.target.listActiveCredentials();
      return Promise.resolve(response(request.id, {
        instanceId: this.options.instanceId,
        topology: this.options.topology,
        connection: this.options.target.getHealth(this.options.instanceId),
        core: this.options.coreStatus(),
        pairing: {
          paired: active.length === 1,
          openId: active[0]?.openId ?? null,
          pending: this.options.target.listPairingRequests('pending').length,
        },
      }));
    }
    if (request.method === 'verify') {
      return this.options.verifyCore().then((verified) => response(request.id, verified));
    }
    if (request.method === 'pair.code.create') {
      if (this.options.target.listActiveCredentials().length > 0) {
        throw new FeishuGatewayError('identity_conflict', 'Feishu identity is already paired');
      }
      const code = randomBytes(24).toString('base64url');
      const expiresAt = Math.min(Number.MAX_SAFE_INTEGER, now + CODE_LIFETIME_MS);
      this.options.target.createPairingCode({
        instanceId: this.options.instanceId,
        codeId: randomUUID(),
        codeHash: digest(code),
        status: 'active',
        expiresAt,
        createdAt: now,
        consumedAt: null,
        consumedEventId: null,
      });
      return Promise.resolve(response(request.id, { code, expiresAt }));
    }
    if (request.method === 'pair.list') {
      const status = request.params.status === 'pending' ? 'pending' : undefined;
      return Promise.resolve(response(request.id, {
        requests: this.options.target.listPairingRequests(status),
      }));
    }
    const requestId = String(request.params.requestId);
    const decision = this.options.target.decidePairingRequest(
      requestId,
      request.method === 'pair.approve' ? 'approve' : 'reject',
      now,
    );
    return Promise.resolve(response(request.id, decision));
  }

  private write(socket: Socket, value: FeishuManagementResponse): void {
    socket.end(`${JSON.stringify(value)}\n`);
  }
}
