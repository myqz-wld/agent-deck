import type { AgentDeckMethodMap } from '@contracts/index';

import type { AgentDeckComposition, LifecycleComponent } from './runtime';

export type CompositionControllerState =
  | 'idle'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped';

function validateComponents(components: readonly LifecycleComponent[]): void {
  const names = new Set<string>();
  for (const component of components) {
    if (!component.name || names.has(component.name)) {
      throw new Error('Composition component names must be non-empty and unique');
    }
    names.add(component.name);
  }
}

/** Starts in declaration order and always stops/rolls back in reverse ownership order. */
export class AgentDeckCompositionController<Methods = AgentDeckMethodMap> {
  private stateValue: CompositionControllerState = 'idle';
  private operation: Promise<void> | null = null;

  constructor(readonly composition: AgentDeckComposition<Methods>) {
    validateComponents(composition.components);
  }

  get state(): CompositionControllerState {
    return this.stateValue;
  }

  start(): Promise<void> {
    if (this.stateValue === 'running') return Promise.resolve();
    if (this.stateValue === 'starting' && this.operation) return this.operation;
    if (this.stateValue !== 'idle') {
      return Promise.reject(new Error(`Cannot start composition from ${this.stateValue}`));
    }
    this.stateValue = 'starting';
    const started: LifecycleComponent[] = [];
    const startWork = async (): Promise<void> => {
      try {
        for (const component of this.composition.components) {
          await component.start();
          started.push(component);
        }
        this.stateValue = 'running';
      } catch (startError) {
        const rollbackErrors: unknown[] = [];
        for (const component of started.reverse()) {
          try {
            await component.stop('composition-start-failed');
          } catch (error) {
            rollbackErrors.push(error);
          }
        }
        this.stateValue = 'stopped';
        if (rollbackErrors.length > 0) {
          throw new AggregateError(
            [startError, ...rollbackErrors],
            'Composition start and rollback failed',
          );
        }
        throw startError;
      }
    };
    const operation = startWork().finally(() => {
      if (this.operation === operation) this.operation = null;
    });
    this.operation = operation;
    return operation;
  }

  stop(reason = 'composition-stopped'): Promise<void> {
    if (this.stateValue === 'stopped') return Promise.resolve();
    if (this.stateValue === 'stopping' && this.operation) return this.operation;
    if (this.stateValue === 'starting' && this.operation) {
      return this.operation.then(
        () => this.stop(reason),
        () => undefined,
      );
    }
    if (this.stateValue === 'idle') {
      this.stateValue = 'stopped';
      return Promise.resolve();
    }
    this.stateValue = 'stopping';
    const operation = (async () => {
      const failures: unknown[] = [];
      for (const component of [...this.composition.components].reverse()) {
        try {
          await component.stop(reason);
        } catch (error) {
          failures.push(error);
        }
      }
      this.stateValue = 'stopped';
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Composition shutdown failed');
      }
    })().finally(() => {
      if (this.operation === operation) this.operation = null;
    });
    this.operation = operation;
    return operation;
  }
}
