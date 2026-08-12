import type { CoreMethod } from '@contracts/index';

export const SERVER_CORE_BASE_METHODS = Object.freeze([
  'pending.list',
  'pending.respond',
  'session.history',
  'session.interrupt',
  'session.runtime.get',
  'session.runtime.update',
  'session.context.get',
  'session.input.capabilities',
  'session.outgoing.list',
  'session.outgoing.remove',
  'session.handoff.preview',
  'session.handoff.commit',
  'session.send',
  'session.steer',
  'subscription.set',
  'system.health',
] as const satisfies readonly CoreMethod[]);
