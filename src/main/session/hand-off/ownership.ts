import { handOffCutoverCoordinator } from './cutover-coordinator';
import {
  listSessionHandOffAliasPages,
  probeSessionHandOffAliases,
  type SessionHandOffAliasPageRequest,
  type SessionHandOffAliasPageRow,
  type SessionHandOffAliasProbeRequest,
  type SessionHandOffAliasProbeResult,
} from '@main/store/session-handoff-alias-repo';
import { eventBus } from '@main/event-bus';
import log from '@main/utils/logger';

const MAX_LOGICAL_OWNERSHIP_LINEAGE = 1_024;
const MAX_LOGICAL_OWNERSHIP_ROWS = 8_192;
const OWNERSHIP_ALIAS_PAGE_SIZE = 64;
const logger = log.scope('handoff-ownership');

interface OwnershipTraversalNode {
  sessionId: string;
  offset: number;
  exhausted: boolean;
  ready: boolean;
}

interface OwnershipTraversal {
  rootId: string;
  lineage: string[];
  seen: Set<string>;
  scheduled: Set<string>;
  nodes: OwnershipTraversalNode[];
  credit: number;
}

interface OwnershipPageContext {
  traversal: OwnershipTraversal;
  node: OwnershipTraversalNode;
  request: SessionHandOffAliasPageRequest;
}

interface OwnershipProbeContext {
  node: OwnershipTraversalNode;
  request: SessionHandOffAliasProbeRequest;
}

export type OwnershipAliasPageReader = (
  requests: readonly SessionHandOffAliasPageRequest[],
) => SessionHandOffAliasPageRow[];

export type OwnershipAliasProbeReader = (
  requests: readonly SessionHandOffAliasProbeRequest[],
) => SessionHandOffAliasProbeResult[];

function allocateTraversalBudgets(
  traversals: readonly OwnershipTraversal[],
  maxRows: number,
): Map<string, number> {
  const budgets = new Map<string, number>();
  let available = maxRows;
  while (available > 0) {
    let progressed = false;
    for (const traversal of traversals) {
      const maximum = Math.min(
        OWNERSHIP_ALIAS_PAGE_SIZE,
        MAX_LOGICAL_OWNERSHIP_LINEAGE - traversal.lineage.length,
      );
      const current = budgets.get(traversal.rootId) ?? 0;
      if (current >= maximum) continue;
      budgets.set(traversal.rootId, current + 1);
      available -= 1;
      progressed = true;
      if (available === 0) break;
    }
    if (!progressed) break;
  }
  return budgets;
}

function buildOwnershipPageRequests(
  traversals: readonly OwnershipTraversal[],
): { requests: SessionHandOffAliasPageRequest[]; contexts: Map<string, OwnershipPageContext> } {
  const requests: SessionHandOffAliasPageRequest[] = [];
  const contexts = new Map<string, OwnershipPageContext>();
  let sequence = 0;
  for (const traversal of traversals) {
    const readyNodes = traversal.nodes.filter((node) => !node.exhausted && node.ready);
    let available = Math.min(
      traversal.credit,
      OWNERSHIP_ALIAS_PAGE_SIZE,
      MAX_LOGICAL_OWNERSHIP_LINEAGE - traversal.lineage.length,
    );
    const limits = new Map<OwnershipTraversalNode, number>();
    while (available > 0 && readyNodes.length > 0) {
      let progressed = false;
      for (const node of readyNodes) {
        const current = limits.get(node) ?? 0;
        if (current >= OWNERSHIP_ALIAS_PAGE_SIZE) continue;
        limits.set(node, current + 1);
        available -= 1;
        progressed = true;
        if (available === 0) break;
      }
      if (!progressed) break;
    }
    for (const [node, limit] of limits) {
      const request: SessionHandOffAliasPageRequest = {
        requestKey: `${traversal.rootId}:${sequence}`,
        successorSessionId: node.sessionId,
        offset: node.offset,
        limit,
      };
      sequence += 1;
      requests.push(request);
      contexts.set(request.requestKey, { traversal, node, request });
    }
  }
  return { requests, contexts };
}

function buildOwnershipProbeRequests(
  traversals: readonly OwnershipTraversal[],
): { requests: SessionHandOffAliasProbeRequest[]; contexts: Map<string, OwnershipProbeContext> } {
  const requests: SessionHandOffAliasProbeRequest[] = [];
  const contexts = new Map<string, OwnershipProbeContext>();
  let sequence = 0;
  for (const traversal of traversals) {
    if (traversal.nodes.some((node) => !node.exhausted && node.ready)) continue;
    for (const node of traversal.nodes) {
      if (node.exhausted || node.ready) continue;
      const request: SessionHandOffAliasProbeRequest = {
        requestKey: `probe:${sequence}`,
        successorSessionId: node.sessionId,
      };
      sequence += 1;
      requests.push(request);
      contexts.set(request.requestKey, { node, request });
    }
  }
  return { requests, contexts };
}

function activeOwnershipTraversals(
  traversals: readonly OwnershipTraversal[],
): OwnershipTraversal[] {
  return traversals.filter((traversal) =>
    traversal.lineage.length < MAX_LOGICAL_OWNERSHIP_LINEAGE &&
    traversal.nodes.some((node) => !node.exhausted));
}

function pruneOwnershipTraversalNodes(traversals: readonly OwnershipTraversal[]): void {
  for (const traversal of traversals) {
    if (traversal.lineage.length >= MAX_LOGICAL_OWNERSHIP_LINEAGE) {
      traversal.nodes = [];
      traversal.credit = 0;
    } else {
      traversal.nodes = traversal.nodes.filter((node) => !node.exhausted);
      if (traversal.nodes.length === 0) traversal.credit = 0;
    }
  }
}

/**
 * Preserve an owner-bound capability across a committed handoff without rewriting its historical
 * provenance. Explicit source reactivation removes the durable alias, so the old source starts a
 * new ownership epoch and no longer grants authority to its former successor.
 */
export function isCurrentHandOffOwner(
  historicalOwnerSessionId: string | null,
  callerSessionId: string,
): boolean {
  if (!historicalOwnerSessionId) return false;
  try {
    const committedSuccessor = handOffCutoverCoordinator.successorForStrict(
      historicalOwnerSessionId,
    );
    return (committedSuccessor ?? historicalOwnerSessionId) === callerSessionId;
  } catch (error) {
    logger.warn(
      `[handoff ownership] denied unresolved owner ${historicalOwnerSessionId}`,
      error,
    );
    return false;
  }
}

/** Current session plus every path-compressed predecessor in its committed handoff chain. */
export function sessionOwnershipLineage(sessionId: string): string[] {
  return sessionOwnershipLineages([sessionId]).get(sessionId) ?? [sessionId];
}

/** Resolve a whole visibility page with bounded batched alias reads instead of one query per row. */
export function sessionOwnershipLineages(sessionIds: readonly string[]): Map<string, string[]> {
  return sessionOwnershipLineagesWithAliasReader(
    sessionIds,
    listSessionHandOffAliasPages,
    probeSessionHandOffAliases,
  );
}

/** Dependency-injected traversal used by production and real-SQLite fairness regressions. */
export function sessionOwnershipLineagesWithAliasReader(
  sessionIds: readonly string[],
  readPages: OwnershipAliasPageReader,
  probeAliases: OwnershipAliasProbeReader,
): Map<string, string[]> {
  const ids = [...new Set(sessionIds)].slice(0, MAX_LOGICAL_OWNERSHIP_LINEAGE);
  const traversals = ids.map<OwnershipTraversal>((rootId) => ({
    rootId,
    lineage: [rootId],
    seen: new Set([rootId]),
    scheduled: new Set([rootId]),
    nodes: [{ sessionId: rootId, offset: 0, exhausted: false, ready: true }],
    credit: 0,
  }));
  try {
    let remainingRows = MAX_LOGICAL_OWNERSHIP_ROWS;
    while (remainingRows > 0) {
      let active = activeOwnershipTraversals(traversals);
      if (active.length === 0) break;
      const probeBatch = buildOwnershipProbeRequests(active);
      if (probeBatch.requests.length > 0) {
        const probeResults = new Map(
          probeAliases(probeBatch.requests).map((result) => [result.requestKey, result]),
        );
        for (const context of probeBatch.contexts.values()) {
          const result = probeResults.get(context.request.requestKey);
          if (!result) throw new Error(`missing handoff alias probe ${context.request.requestKey}`);
          if (result.exhausted) context.node.exhausted = true;
          else context.node.ready = true;
        }
        pruneOwnershipTraversalNodes(active);
        active = activeOwnershipTraversals(traversals);
        if (active.length === 0) break;
      }
      if (!active.some((traversal) => traversal.credit > 0)) {
        const budgets = allocateTraversalBudgets(active, remainingRows);
        for (const traversal of active) {
          traversal.credit = budgets.get(traversal.rootId) ?? 0;
        }
      }
      const { requests, contexts } = buildOwnershipPageRequests(active);
      if (requests.length === 0) break;
      const rows = readPages(requests);
      remainingRows -= rows.length;
      const rowsByRequest = new Map<string, SessionHandOffAliasPageRow[]>();
      for (const row of rows) {
        const page = rowsByRequest.get(row.requestKey) ?? [];
        page.push(row);
        rowsByRequest.set(row.requestKey, page);
      }
      for (const context of contexts.values()) {
        const page = rowsByRequest.get(context.request.requestKey) ?? [];
        context.node.offset += page.length;
        context.traversal.credit = Math.max(0, context.traversal.credit - page.length);
        if (page.length < context.request.limit) context.node.exhausted = true;
        for (const alias of page) {
          if (
            alias.successorSessionId !== context.node.sessionId ||
            context.traversal.lineage.length >= MAX_LOGICAL_OWNERSHIP_LINEAGE ||
            context.traversal.seen.has(alias.sourceSessionId)
          ) continue;
          context.traversal.seen.add(alias.sourceSessionId);
          context.traversal.lineage.push(alias.sourceSessionId);
          if (
            context.traversal.lineage.length < MAX_LOGICAL_OWNERSHIP_LINEAGE &&
            !context.traversal.scheduled.has(alias.sourceSessionId)
          ) {
            context.traversal.scheduled.add(alias.sourceSessionId);
            context.traversal.nodes.push({
              sessionId: alias.sourceSessionId,
              offset: 0,
              exhausted: false,
              ready: false,
            });
          }
        }
      }
      pruneOwnershipTraversalNodes(active);
    }
  } catch {
    // Startup/shutdown and isolated tests may evaluate visibility before the DB is available.
  }
  return new Map(traversals.map((traversal) => [traversal.rootId, traversal.lineage]));
}

/** Notify ownership-bound services after commit; listener failures cannot roll back the handoff. */
export function notifySessionHandOffCommitted(
  sourceSessionId: string,
  successorSessionId: string,
): void {
  try {
    eventBus.emit('session-hand-off-committed', { sourceSessionId, successorSessionId });
  } catch (error) {
    logger.error(
      `[handoff ownership] committed-listener failed source=${sourceSessionId} successor=${successorSessionId}`,
      error,
    );
  }
}
