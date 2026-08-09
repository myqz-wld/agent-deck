import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  APPEND_ISSUE_CONTEXT_SCHEMA,
  REPORT_ISSUE_SCHEMA,
  UPDATE_ISSUE_STATUS_SCHEMA,
  type AppendIssueContextArgs,
  type ReportIssueArgs,
  type UpdateIssueStatusArgs,
} from '@main/agent-deck-mcp/tools/schemas';
import { detectGitBranchName } from '@main/utils/git-branch';
import { normalizeIssueBranchName, type IssueRecord } from '@shared/types';

import { projectServerCoreIssue } from './issue-projection';
import {
  requireServerCoreMcpCaller,
  type ServerCoreMcpCallContext,
} from './mcp-tool-host';
import { serverCoreMcpError, serverCoreMcpOk } from './mcp-result';

const MUTATION_HINT =
  'Do not retry automatically after an ambiguous storage failure. Read the Issues board first, then retry only if the requested mutation is absent.';

function inside(root: string, target: string): boolean {
  const child = relative(root, target);
  return child === '' || (
    child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
  );
}

function issueCwd(
  context: ServerCoreMcpCallContext,
  sessionCwd: string,
  requested: string | null | undefined,
): string {
  const workspaceRoot = resolve(context.host.workspaceRoot);
  const sessionRoot = resolve(sessionCwd);
  if (!inside(workspaceRoot, sessionRoot)) {
    throw new Error('Caller session directory escapes the Workspace');
  }
  const candidate = requested == null
    ? sessionRoot
    : resolve(isAbsolute(requested) ? requested : resolve(sessionRoot, requested));
  if (!inside(workspaceRoot, candidate)) {
    throw new Error('Issue directory escapes the Workspace');
  }
  if (!existsSync(candidate) || realpathSync(candidate) !== candidate) {
    throw new Error('Issue directory must be an existing canonical Workspace path');
  }
  return candidate;
}

function projectIssue(context: ServerCoreMcpCallContext, issue: IssueRecord) {
  return projectServerCoreIssue(
    issue,
    issue.appendices ?? context.host.issues.listAppendices(issue.id),
    { workspaceRoot: context.host.workspaceRoot, privateRoots: context.host.privateRoots },
  );
}

async function reportIssue(args: ReportIssueArgs, context: ServerCoreMcpCallContext) {
  try {
    const caller = requireServerCoreMcpCaller(context);
    const cwd = issueCwd(context, caller.session.cwd, args.cwd);
    const created = context.host.issues.create({
      title: args.title,
      description: args.description,
      repro: args.repro ?? null,
      kind: args.kind,
      severity: args.severity,
      sourceSessionId: caller.sessionId,
      cwd,
      branchName: normalizeIssueBranchName(detectGitBranchName(cwd)),
      logsRef: args.logsRef ?? null,
      labels: args.labels,
    });
    context.host.metadata.appendChange('issue.created', created.id, {
      issueId: created.id,
      status: created.status,
      updatedAt: created.updatedAt,
    });
    return serverCoreMcpOk(projectIssue(context, created));
  } catch (error) {
    return serverCoreMcpError(error, MUTATION_HINT);
  }
}

async function appendIssue(
  args: AppendIssueContextArgs,
  context: ServerCoreMcpCallContext,
) {
  try {
    const caller = requireServerCoreMcpCaller(context);
    const issue = context.host.issues.get(args.issueId);
    if (!issue) throw new Error(`Issue ${args.issueId} was not found`);
    if (!context.host.ownership.isCurrentOwner(issue.sourceSessionId, caller.sessionId)) {
      throw new Error('Caller is not the current owner of the issue source lineage');
    }
    if (issue.deletedAt !== null) throw new Error('Deleted issues cannot accept context');
    if (issue.status === 'resolved') throw new Error('Resolved issues must be reopened first');
    const updated = context.host.issues.appendContext({
      issueId: args.issueId,
      body: args.additionalContext,
      logsRef: args.logsRef ?? null,
      appendedSessionId: caller.sessionId,
    });
    if (!updated) throw new Error(`Issue ${args.issueId} disappeared during append`);
    context.host.metadata.appendChange('issue.updated', updated.id, {
      issueId: updated.id,
      status: updated.status,
      updatedAt: updated.updatedAt,
    });
    return serverCoreMcpOk(projectIssue(context, updated));
  } catch (error) {
    return serverCoreMcpError(error, MUTATION_HINT);
  }
}

async function updateIssueStatus(
  args: UpdateIssueStatusArgs,
  context: ServerCoreMcpCallContext,
) {
  try {
    const caller = requireServerCoreMcpCaller(context);
    const issue = context.host.issues.get(args.issueId);
    if (!issue) throw new Error(`Issue ${args.issueId} was not found`);
    const ownsSource = context.host.ownership.isCurrentOwner(
      issue.sourceSessionId,
      caller.sessionId,
    );
    const ownsResolution = context.host.ownership.isCurrentOwner(
      issue.resolutionSessionId,
      caller.sessionId,
    );
    if (!ownsSource && !ownsResolution) {
      throw new Error('Caller is not a current owner of the issue source or resolution lineage');
    }
    if (issue.deletedAt !== null) throw new Error('Deleted issues cannot change status');
    const updated = context.host.issues.updateStatusWithNote({
      issueId: args.issueId,
      status: args.status,
      ...(args.note !== undefined ? { note: args.note } : {}),
      appendedSessionId: caller.sessionId,
    });
    if (!updated) throw new Error(`Issue ${args.issueId} disappeared during update`);
    context.host.metadata.appendChange('issue.updated', updated.id, {
      issueId: updated.id,
      status: updated.status,
      updatedAt: updated.updatedAt,
    });
    return serverCoreMcpOk(projectIssue(context, updated));
  } catch (error) {
    return serverCoreMcpError(error, MUTATION_HINT);
  }
}

export function registerServerCoreIssueTools(
  server: McpServer,
  context: ServerCoreMcpCallContext,
): void {
  server.registerTool('report_issue', {
    description: 'Report one issue owned by this authenticated session inside the Workspace.',
    inputSchema: REPORT_ISSUE_SCHEMA,
  }, (args) => reportIssue(args, context));
  server.registerTool('append_issue_context', {
    description: 'Append bounded context to an issue owned by this session lineage.',
    inputSchema: APPEND_ISSUE_CONTEXT_SCHEMA,
  }, (args) => appendIssue(args, context));
  server.registerTool('update_issue_status', {
    description: 'Update status for an issue owned by this source or resolution lineage.',
    inputSchema: UPDATE_ISSUE_STATUS_SCHEMA,
  }, (args) => updateIssueStatus(args, context));
}
