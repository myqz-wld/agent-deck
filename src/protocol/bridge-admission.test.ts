import { describe, expect, it } from 'vitest';

import {
  BridgeAdmissionDecoder,
  BridgeAdmissionError,
  encodeBridgeAdmission,
  type BridgeAdmission,
} from './bridge-admission';

const CLIENT: BridgeAdmission = {
  version: 1,
  topology: 'server-core',
  role: 'client',
  instanceId: 'tenant-a',
  credentialId: 'ssh-credential-a',
};

describe('private bridge admission framing', () => {
  it('preserves fragmented admission and coalesced opaque transport bytes', () => {
    const admission = encodeBridgeAdmission(CLIENT);
    const transport = new Uint8Array([0, 1, 2, 3, 255]);
    const tail = new Uint8Array(admission.byteLength - 2 + transport.byteLength);
    tail.set(admission.subarray(2));
    tail.set(transport, admission.byteLength - 2);
    const decoder = new BridgeAdmissionDecoder();

    expect(decoder.push(admission.subarray(0, 2))).toBeNull();
    expect(decoder.push(tail)).toEqual({ admission: CLIENT, remainder: transport });
    expect(() => decoder.push(new Uint8Array())).toThrowError(
      expect.objectContaining<Partial<BridgeAdmissionError>>({ code: 'admission_state' }),
    );
  });

  it('validates exact topology/role fields and rejects unknown data', () => {
    expect(() =>
      encodeBridgeAdmission({ ...CLIENT, extra: true } as BridgeAdmission),
    ).toThrow('Unknown admission field');
    expect(() =>
      encodeBridgeAdmission({ ...CLIENT, role: 'worker' } as BridgeAdmission),
    ).toThrow('Missing admission field: workerId');
    expect(() =>
      encodeBridgeAdmission({
        ...CLIENT,
        topology: 'server-core',
        role: 'worker',
        workerId: 'worker-a',
      } as unknown as BridgeAdmission),
    ).toThrow('Worker admission requires Relay');
  });

  it('rejects an oversized declaration before retaining its body', () => {
    const prefix = new Uint8Array(4);
    new DataView(prefix.buffer).setUint32(0, 65, false);
    const decoder = new BridgeAdmissionDecoder(64);
    expect(() => decoder.push(prefix)).toThrowError(
      expect.objectContaining<Partial<BridgeAdmissionError>>({ code: 'admission_oversized' }),
    );
    expect(decoder.bufferedBytes).toBe(4);
  });
});
