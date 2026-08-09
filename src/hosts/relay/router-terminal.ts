import { RelayMetadataStore } from './metadata';
import type { RelayResetCode, RelayRouteFrame } from '@protocol/relay';
import {
  closeRelayRoute,
  createRelayResetFrame,
  type RelayClientState,
  type RelayStreamState,
} from './router-state';
import type { RelayClientDisconnect } from './router-types';
import type { WorkerLeaseStatus } from './worker-lease';

export interface RelayTerminalCoordinatorOptions {
  instanceId: string;
  metadata: RelayMetadataStore;
  clients: Map<string, RelayClientState>;
  streams: Map<string, RelayStreamState>;
  clientDisconnects: RelayClientDisconnect[];
  dropStreamQueues(streamId: string): void;
  enqueueWorker(frame: RelayRouteFrame): boolean;
  workerStatus(): WorkerLeaseStatus;
  onWorkerDeliveryFailure(): void;
}

export class RelayTerminalCoordinator {
  constructor(private readonly options: RelayTerminalCoordinatorOptions) {}

  disconnectClient(
    clientId: string,
    reason: RelayClientDisconnect['reason'] = 'resync_required',
  ): void {
    const client = this.options.clients.get(clientId);
    if (!client) return;
    const streams = [...this.options.streams.values()].filter(
      (stream) => stream.clientId === clientId,
    );
    for (const stream of streams) {
      this.options.dropStreamQueues(stream.streamId);
      closeRelayRoute(this.options.metadata, stream.streamId, 'closed');
      this.options.streams.delete(stream.streamId);
    }
    client.queue.clear();
    this.options.clients.delete(clientId);
    this.options.clientDisconnects.push({ clientId, reason });
    for (const stream of streams) {
      const status = this.options.workerStatus();
      if (!status.online || status.generation !== stream.generation) continue;
      const delivered = this.options.enqueueWorker(
        createRelayResetFrame(
          this.options.instanceId,
          stream,
          'client-to-worker',
          'cancelled',
          stream.nextClientSequence,
        ),
      );
      if (!delivered) {
        this.options.onWorkerDeliveryFailure();
        break;
      }
    }
  }

  enqueueResetToClient(
    client: RelayClientState,
    streamId: string,
    generation: number,
    sequence: number,
    code: RelayResetCode,
  ): boolean {
    client.queue.dropStream(streamId);
    const delivered = client.queue.enqueue(
      createRelayResetFrame(
        this.options.instanceId,
        { generation, streamId },
        'worker-to-client',
        code,
        sequence,
      ),
    );
    if (!delivered) this.disconnectClient(client.clientId, 'resync_required');
    return delivered;
  }

  failStream(
    stream: RelayStreamState,
    code: RelayResetCode,
    notifyClient: boolean,
    notifyWorker: boolean,
  ): RelayResetCode | null {
    if (this.options.streams.get(stream.streamId) !== stream) return null;
    this.options.dropStreamQueues(stream.streamId);
    closeRelayRoute(
      this.options.metadata,
      stream.streamId,
      code === 'worker_fenced' ? 'fenced' : 'closed',
    );
    this.options.streams.delete(stream.streamId);

    const client = this.options.clients.get(stream.clientId);
    const clientDelivered =
      !notifyClient ||
      !client ||
      this.enqueueResetToClient(
        client,
        stream.streamId,
        stream.generation,
        stream.nextWorkerSequence,
        code,
      );
    let workerDelivered = true;
    if (notifyWorker && this.options.workerStatus().online) {
      workerDelivered = this.options.enqueueWorker(
        createRelayResetFrame(
          this.options.instanceId,
          stream,
          'client-to-worker',
          code,
          stream.nextClientSequence,
        ),
      );
      if (!workerDelivered) this.options.onWorkerDeliveryFailure();
    }
    if (!clientDelivered) return 'resync_required';
    return workerDelivered ? null : 'worker_disconnected';
  }

  failAllStreams(code: RelayResetCode): void {
    const streams = [...this.options.streams.values()];
    for (const stream of streams) {
      this.options.dropStreamQueues(stream.streamId);
      closeRelayRoute(
        this.options.metadata,
        stream.streamId,
        code === 'worker_fenced' ? 'fenced' : 'closed',
      );
      this.options.streams.delete(stream.streamId);
    }
    for (const stream of streams) {
      const client = this.options.clients.get(stream.clientId);
      if (client) {
        this.enqueueResetToClient(
          client,
          stream.streamId,
          stream.generation,
          stream.nextWorkerSequence,
          code,
        );
      }
    }
  }
}
