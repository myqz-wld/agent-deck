import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { createConnection } from 'node:net';
import type { JsonValue } from '@contracts/index';
import {
  FEISHU_MANAGEMENT_MAX_LINE_BYTES,
  parseFeishuManagementResponse,
  type FeishuManagementMethod,
} from '@shared/feishu-management';

const TIMEOUT_MS = 3_000;

export interface FeishuManagementClientPort {
  request(method: FeishuManagementMethod, params: Record<string, JsonValue>): Promise<JsonValue>;
}

function verifySocket(path: string, expectedUid: number): void {
  const metadata = lstatSync(path);
  if (
    !metadata.isSocket() || metadata.isSymbolicLink() ||
    metadata.uid !== expectedUid || (metadata.mode & 0o777) !== 0o600
  ) throw new Error('Feishu management socket trust check failed');
}

export class FeishuManagementClient implements FeishuManagementClientPort {
  constructor(
    private readonly socketPath: string,
    private readonly expectedUid: number,
  ) {}

  request(
    method: FeishuManagementMethod,
    params: Record<string, JsonValue>,
  ): Promise<JsonValue> {
    verifySocket(this.socketPath, this.expectedUid);
    const id = randomUUID();
    const encoded = Buffer.from(`${JSON.stringify({
      schemaVersion: 1,
      id,
      method,
      params,
    })}\n`, 'utf8');
    return new Promise<JsonValue>((resolve, reject) => {
      const socket = createConnection({ path: this.socketPath });
      let settled = false;
      let bytes = Buffer.alloc(0);
      const finish = (operation: () => void) => {
        if (settled) return;
        settled = true;
        encoded.fill(0);
        bytes.fill(0);
        socket.destroy();
        operation();
      };
      socket.setTimeout(TIMEOUT_MS, () => finish(() => reject(new Error(
        'Feishu management request timed out',
      ))));
      socket.once('connect', () => socket.write(encoded));
      socket.on('data', (chunk: Buffer) => {
        if (settled) return;
        bytes = Buffer.concat([bytes, chunk], bytes.length + chunk.length);
        if (bytes.length > FEISHU_MANAGEMENT_MAX_LINE_BYTES) {
          finish(() => reject(new Error('Feishu management response exceeded its bound')));
          return;
        }
        const newline = bytes.indexOf(0x0a);
        if (newline < 0) return;
        try {
          const response = parseFeishuManagementResponse(
            JSON.parse(bytes.subarray(0, newline).toString('utf8')),
            id,
          );
          if (!response.ok) {
            finish(() => reject(new Error(`Feishu management request failed: ${response.error.code}`)));
            return;
          }
          finish(() => resolve(response.result));
        } catch (error) {
          finish(() => reject(error));
        }
      });
      socket.once('error', (error) => finish(() => reject(error)));
      socket.once('end', () => {
        if (!settled) finish(() => reject(new Error('Feishu management response was incomplete')));
      });
    });
  }
}
