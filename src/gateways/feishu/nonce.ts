import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  FeishuGatewayError,
  type FeishuPendingAction,
  type PendingActionNonceBinding,
  type PendingActionNoncePort,
} from '@gateways/im';

const PREFIX = 'v1.';
const MAC_BYTES = 32;
const NONCE = /^v1\.(0|[1-9][0-9]{0,15})\.([A-Za-z0-9_-]{43})$/;

export interface FeishuPresentationActionSigner {
  signPresentation(
    action: Omit<FeishuPendingAction, 'value'>,
    expiresAt: number | null,
  ): string;
}

export interface FeishuActionSecretDisposalPort {
  dispose(): void;
}

function canonical(binding: PendingActionNonceBinding, expiresAt: number): Buffer {
  const fields: Array<string | number> = [
    binding.instanceId,
    binding.credentialId,
    binding.chatId,
    binding.chatType,
    binding.sessionId,
    binding.requestId,
    binding.revision,
    binding.contentDigest,
    binding.action,
    expiresAt,
  ];
  const chunks: Buffer[] = [];
  for (const field of fields) {
    const value = Buffer.from(String(field), 'utf8');
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(value.length);
    chunks.push(length, value);
  }
  return Buffer.concat(chunks);
}

export class HmacPendingActionNonce implements
  PendingActionNoncePort,
  FeishuPresentationActionSigner,
  FeishuActionSecretDisposalPort {
  private readonly secret: Buffer;
  private readonly now: () => number;
  private readonly defaultLifetimeMs: number;
  private disposed = false;

  constructor(
    secret: Uint8Array,
    options: { now?: () => number; defaultLifetimeMs?: number } = {},
  ) {
    if (secret.byteLength < 32 || secret.byteLength > 1_024) {
      throw new FeishuGatewayError('invalid_configuration', 'Action MAC secret has an invalid length');
    }
    this.secret = Buffer.from(secret);
    this.now = options.now ?? (() => Date.now());
    this.defaultLifetimeMs = options.defaultLifetimeMs ?? 30 * 60 * 1_000;
    if (
      !Number.isSafeInteger(this.defaultLifetimeMs) ||
      this.defaultLifetimeMs < 0 ||
      this.defaultLifetimeMs > 7 * 24 * 60 * 60 * 1_000
    ) throw new FeishuGatewayError('invalid_configuration', 'Action presentation lifetime is invalid');
  }

  issue(binding: PendingActionNonceBinding): string {
    this.assertActive();
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new FeishuGatewayError('invalid_configuration', 'Action MAC clock is invalid');
    }
    const expiresAt = this.defaultLifetimeMs === 0
      ? 0
      : Math.min(Number.MAX_SAFE_INTEGER, now + this.defaultLifetimeMs);
    return this.issueBound(binding, expiresAt);
  }

  signPresentation(
    action: Omit<FeishuPendingAction, 'value'>,
    expiresAt: number | null,
  ): string {
    this.assertActive();
    const { name, nonce: _nonce, ...binding } = action;
    if (name !== 'pending.respond') {
      throw new FeishuGatewayError('invalid_core_response', 'Pending action name is invalid');
    }
    const deadline = expiresAt ?? 0;
    if (!Number.isSafeInteger(deadline) || deadline < 0) {
      throw new FeishuGatewayError('invalid_core_response', 'Presentation deadline is invalid');
    }
    return this.issueBound(binding, deadline);
  }

  verify(binding: PendingActionNonceBinding, nonce: string): boolean {
    if (this.disposed) return false;
    const match = typeof nonce === 'string' ? nonce.match(NONCE) : null;
    const parsed = match ? Number(match[1]) : 0;
    const expiryValid = Number.isSafeInteger(parsed) && parsed >= 0;
    const expected = this.mac(binding, expiryValid ? parsed : 0);
    let candidate = Buffer.alloc(MAC_BYTES);
    let syntaxValid = Boolean(match && expiryValid);
    if (match) {
      try {
        const encoded = match[2];
        const decoded = Buffer.from(encoded, 'base64url');
        syntaxValid = decoded.length === MAC_BYTES && decoded.toString('base64url') === encoded;
        if (decoded.length === MAC_BYTES) candidate = decoded;
      } catch {
        syntaxValid = false;
      }
    }
    const current = this.now();
    const timeValid = Number.isSafeInteger(current) && current >= 0 && (parsed === 0 || current <= parsed);
    return timingSafeEqual(expected, candidate) && syntaxValid && timeValid;
  }

  private issueBound(binding: PendingActionNonceBinding, expiresAt: number): string {
    return `${PREFIX}${expiresAt}.${this.mac(binding, expiresAt).toString('base64url')}`;
  }

  private mac(binding: PendingActionNonceBinding, expiresAt: number): Buffer {
    return createHmac('sha256', this.secret).update(canonical(binding, expiresAt)).digest();
  }

  dispose(): void {
    if (this.disposed) return;
    this.secret.fill(0);
    this.disposed = true;
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new FeishuGatewayError('gateway_closed', 'Action MAC has been disposed');
    }
  }
}
