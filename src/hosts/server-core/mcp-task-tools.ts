import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  TASK_CREATE_SCHEMA,
  TASK_DELETE_SCHEMA,
  TASK_GET_SCHEMA,
  TASK_LIST_SCHEMA,
  TASK_UPDATE_SCHEMA,
  type TaskCreateArgs,
  type TaskDeleteArgs,
  type TaskGetArgs,
  type TaskListArgs,
  type TaskUpdateArgs,
} from '@main/agent-deck-mcp/tools/schemas';
import type { TaskRecord } from '@shared/types';

import {
  activeTeamIds,
  isActiveTeamMember,
  requireServerCoreMcpCaller,
  type ServerCoreMcpCallContext,
} from './mcp-tool-host';
import { serverCoreMcpError, serverCoreMcpOk } from './mcp-result';
import type { ServerCoreTaskCreateInput } from './session-task-read-repository';

const STORAGE_HINT =
  'Re-read the task list before retrying: the mutation may already have committed. ' +
  'Retry only when the requested task change is absent; otherwise inspect Server Core diagnostics.';

function taskPatch(args: Omit<TaskUpdateArgs, 'taskId'>): Partial<ServerCoreTaskCreateInput> {
  const result: Partial<ServerCoreTaskCreateInput> = {};
  for (const key of [
    'subject',
    'description',
    'status',
    'activeForm',
    'priority',
    'blocks',
    'blockedBy',
    'labels',
    'teamId',
  ] as const) {
    if (args[key] !== undefined) result[key] = args[key] as never;
  }
  return result;
}

function canWrite(
  context: ServerCoreMcpCallContext,
  callerSessionId: string,
  task: Pick<TaskRecord, 'ownerSessionId' | 'teamId'>,
): boolean {
  return task.teamId === null
    ? task.ownerSessionId === callerSessionId
    : isActiveTeamMember(context.host, callerSessionId, task.teamId);
}

async function createTask(args: TaskCreateArgs, context: ServerCoreMcpCallContext) {
  try {
    const caller = requireServerCoreMcpCaller(context);
    const teamId = args.teamId ?? null;
    if (teamId !== null && !isActiveTeamMember(context.host, caller.sessionId, teamId)) {
      throw new Error('Caller is not an active member of the requested task team');
    }
    const created = context.host.tasks.create({
      ownerSessionId: caller.sessionId,
      teamId,
      subject: args.subject,
      ...(args.description !== undefined ? { description: args.description } : {}),
      ...(args.status !== undefined ? { status: args.status } : {}),
      ...(args.activeForm !== undefined ? { activeForm: args.activeForm } : {}),
      ...(args.priority !== undefined ? { priority: args.priority } : {}),
      ...(args.blocks !== undefined ? { blocks: args.blocks } : {}),
      ...(args.blockedBy !== undefined ? { blockedBy: args.blockedBy } : {}),
      ...(args.labels !== undefined ? { labels: args.labels } : {}),
    });
    context.host.metadata.appendChange('task.created', created.id, {
      taskId: created.id,
      ownerSessionId: created.ownerSessionId,
      teamId: created.teamId,
      status: created.status,
      updatedAt: created.updatedAt,
    });
    return serverCoreMcpOk(created);
  } catch (error) {
    return serverCoreMcpError(error, STORAGE_HINT);
  }
}

async function listTasks(args: TaskListArgs, context: ServerCoreMcpCallContext) {
  try {
    const caller = requireServerCoreMcpCaller(context);
    const limit = args.limit ?? 100;
    let tasks: TaskRecord[];
    if (args.teamIdFilter === undefined) {
      tasks = context.host.tasks.list({
        status: args.statusFilter,
        subjectKeyword: args.subjectFilter,
        visibleScope: {
          teamIds: activeTeamIds(context.host, caller.sessionId),
          callerSid: caller.sessionId,
        },
        limit,
        offset: args.offset,
      });
    } else if (args.teamIdFilter === 'null-personal') {
      tasks = context.host.tasks.list({
        status: args.statusFilter,
        subjectKeyword: args.subjectFilter,
        ownerSessionIds: [caller.sessionId],
        teamIdFilter: 'null-personal',
        limit,
        offset: args.offset,
      });
    } else {
      if (!isActiveTeamMember(context.host, caller.sessionId, args.teamIdFilter)) {
        throw new Error('Caller is not an active member of the requested task team');
      }
      tasks = context.host.tasks.list({
        status: args.statusFilter,
        subjectKeyword: args.subjectFilter,
        teamIdFilter: args.teamIdFilter,
        limit,
        offset: args.offset,
      });
    }
    return serverCoreMcpOk({
      total: tasks.length,
      hasMore: tasks.length === limit,
      tasks,
    });
  } catch (error) {
    return serverCoreMcpError(error, STORAGE_HINT);
  }
}

async function getTask(args: TaskGetArgs, context: ServerCoreMcpCallContext) {
  try {
    const caller = requireServerCoreMcpCaller(context);
    const task = context.host.tasks.get(args.taskId);
    if (!task) throw new Error(`Task ${args.taskId} was not found`);
    if (!canWrite(context, caller.sessionId, task)) {
      throw new Error('Caller cannot read the requested task');
    }
    return serverCoreMcpOk(task);
  } catch (error) {
    return serverCoreMcpError(error, 'Call task_list to discover tasks visible to this session.');
  }
}

async function updateTask(args: TaskUpdateArgs, context: ServerCoreMcpCallContext) {
  try {
    const caller = requireServerCoreMcpCaller(context);
    const existing = context.host.tasks.get(args.taskId);
    if (!existing) throw new Error(`Task ${args.taskId} was not found`);
    if (!canWrite(context, caller.sessionId, existing)) {
      throw new Error('Caller cannot update the requested task');
    }
    if (
      typeof args.teamId === 'string' &&
      !isActiveTeamMember(context.host, caller.sessionId, args.teamId)
    ) {
      throw new Error('Caller is not an active member of the replacement task team');
    }
    if (
      args.teamId === null && existing.teamId !== null &&
      existing.ownerSessionId !== caller.sessionId
    ) {
      throw new Error('Only the task owner can convert a team task to a personal task');
    }
    const { taskId: _taskId, ...rest } = args;
    const patch = taskPatch(rest);
    if (Object.keys(patch).length === 0) return serverCoreMcpOk(existing);
    const updated = context.host.tasks.update(args.taskId, patch);
    if (!updated) throw new Error(`Task ${args.taskId} disappeared during update`);
    context.host.metadata.appendChange('task.updated', updated.id, {
      taskId: updated.id,
      ownerSessionId: updated.ownerSessionId,
      teamId: updated.teamId,
      status: updated.status,
      updatedAt: updated.updatedAt,
    });
    return serverCoreMcpOk(updated);
  } catch (error) {
    return serverCoreMcpError(error, STORAGE_HINT);
  }
}

async function deleteTask(args: TaskDeleteArgs, context: ServerCoreMcpCallContext) {
  try {
    const caller = requireServerCoreMcpCaller(context);
    const existing = context.host.tasks.get(args.taskId);
    if (!existing) throw new Error(`Task ${args.taskId} was not found`);
    if (!canWrite(context, caller.sessionId, existing)) {
      throw new Error('Caller cannot delete the requested task');
    }
    const deletedIds = context.host.tasks.delete(args.taskId, {
      cascade: args.force ?? false,
      predicate: (_id, task) => canWrite(context, caller.sessionId, task),
    });
    for (const taskId of deletedIds) {
      context.host.metadata.appendChange('task.deleted', taskId, { taskId });
    }
    return serverCoreMcpOk({ success: deletedIds.length > 0, taskId: args.taskId, deletedIds });
  } catch (error) {
    return serverCoreMcpError(error, STORAGE_HINT);
  }
}

export function registerServerCoreTaskTools(
  server: McpServer,
  context: ServerCoreMcpCallContext,
): void {
  server.registerTool('task_create', {
    description: 'Create a personal or active-team task owned by this authenticated session.',
    inputSchema: TASK_CREATE_SCHEMA,
  }, (args) => createTask(args, context));
  server.registerTool('task_list', {
    description: 'List personal and active-team tasks visible to this authenticated session.',
    inputSchema: TASK_LIST_SCHEMA,
  }, (args) => listTasks(args, context));
  server.registerTool('task_get', {
    description: 'Read one task visible to this authenticated session.',
    inputSchema: TASK_GET_SCHEMA,
  }, (args) => getTask(args, context));
  server.registerTool('task_update', {
    description: 'Update one task writable by this authenticated session.',
    inputSchema: TASK_UPDATE_SCHEMA,
  }, (args) => updateTask(args, context));
  server.registerTool('task_delete', {
    description: 'Delete one writable task and optionally its writable downstream tasks.',
    inputSchema: TASK_DELETE_SCHEMA,
  }, (args) => deleteTask(args, context));
}
