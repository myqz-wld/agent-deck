import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it } from 'vitest';

import { createServerCoreMcpServer } from './mcp-server';
import {
  structuredPayload,
  textPayload,
  withClient,
} from './mcp-server-test-client';
import {
  cleanupMcpServerHarnesses,
  createMcpServerHarness,
  mcpTestSession,
} from './mcp-server.test-fixture';

const harness = createMcpServerHarness;
const session = mcpTestSession;

afterEach(cleanupMcpServerHarnesses);

describe('Server Core MCP tools', () => {
  it('publishes the exact Core-owned collaboration, task, and Issue surface', async () => {
    const { host } = harness();
    const server = await createServerCoreMcpServer(
      host,
      () => 'caller-a',
      'codex-cli',
      { McpServer },
    );
    await withClient(server, async (client) => {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        'append_issue_context',
        'browser_click',
        'browser_close',
        'browser_evaluate',
        'browser_navigate',
        'browser_open',
        'browser_press',
        'browser_read_console',
        'browser_read_network',
        'browser_screenshot',
        'browser_scroll',
        'browser_snapshot',
        'browser_tabs',
        'browser_type',
        'browser_wait',
        'enter_worktree',
        'exit_worktree',
        'get_session',
        'hand_off_session',
        'list_session_events',
        'list_sessions',
        'present_diff',
        'present_plan',
        'report_issue',
        'send_message',
        'shutdown_session',
        'spawn_session',
        'task_create',
        'task_delete',
        'task_get',
        'task_list',
        'task_update',
        'update_issue_status',
      ]);
      const browserTools = new Set([
        'browser_click', 'browser_close', 'browser_evaluate', 'browser_navigate',
        'browser_open', 'browser_press', 'browser_read_console', 'browser_read_network',
        'browser_screenshot', 'browser_scroll', 'browser_snapshot', 'browser_tabs',
        'browser_type', 'browser_wait',
      ]);
      for (const tool of tools.tools) {
        if (browserTools.has(tool.name)) expect(tool.outputSchema).toBeUndefined();
        else expect(tool.outputSchema).toMatchObject({
          type: 'object',
          additionalProperties: false,
        });
      }
      const tabs = await client.callTool({ name: 'browser_tabs', arguments: {} });
      expect(tabs.isError).not.toBe(true);
      expect(textPayload(tabs)).toEqual({ tabs: [] });
      expect(host.browser.invoke).toHaveBeenCalledWith('caller-a', 'browser_tabs', {});
      const plan = await client.callTool({
        name: 'present_plan',
        arguments: { plan: '# Remote plan' },
      });
      expect(structuredPayload(plan)).toEqual({ decision: 'approved' });
      expect(host.presentations.requestPlan).toHaveBeenCalledWith('caller-a', {
        plan: '# Remote plan',
      });
    });
  });

  it('returns schema-validated structured success for every non-Browser tool', async () => {
    const { host } = harness();
    const server = await createServerCoreMcpServer(
      host,
      () => 'caller-a',
      'codex-cli',
      { McpServer },
    );
    await withClient(server, async (client) => {
      const called: string[] = [];
      const call = async (name: string, args: Record<string, unknown> = {}) => {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError, name).not.toBe(true);
        called.push(name);
        return structuredPayload(result);
      };

      await call('list_sessions');
      await call('get_session', { sessionId: 'caller-b' });
      await call('list_session_events', { sessionId: 'caller-b' });
      await call('send_message', { sessionId: 'caller-b', text: 'Inspect' });
      await call('shutdown_session', { sessionId: 'caller-b' });
      await call('spawn_session', {
        adapter: 'codex-cli', cwd: '.', prompt: 'Inspect',
      });
      await call('hand_off_session', { prompt: 'Continue' });
      await call('present_plan', { plan: '# Plan' });
      await call('present_diff', {
        mode: 'pr',
        title: 'Diff',
        rationale: 'Verify',
        instructions: 'Approve',
        pr: { before: 'old', after: 'new' },
      });
      await call('enter_worktree', { startPoint: 'HEAD' });
      await call('exit_worktree');

      const task = await call('task_create', { subject: 'contract task' });
      const taskId = String(task.id);
      await call('task_list');
      await call('task_get', { taskId });
      await call('task_update', { taskId, status: 'active' });
      await call('task_delete', { taskId });

      const issue = await call('report_issue', {
        title: 'Contract issue', description: 'Validate output', cwd: '.',
      });
      const issueId = String(issue.id);
      await call('append_issue_context', { issueId, additionalContext: 'More evidence' });
      await call('update_issue_status', { issueId, status: 'in-progress' });

      expect(called.sort()).toEqual([
        'append_issue_context', 'enter_worktree', 'exit_worktree', 'get_session',
        'hand_off_session', 'list_session_events', 'list_sessions', 'present_diff',
        'present_plan', 'report_issue', 'send_message', 'shutdown_session', 'spawn_session',
        'task_create', 'task_delete', 'task_get', 'task_list', 'task_update',
        'update_issue_status',
      ]);
    });
  });

  it('revalidates the caller and enforces personal and active-team task authority', async () => {
    const { changes, host, records } = harness();
    const server = await createServerCoreMcpServer(
      host,
      () => 'caller-a',
      'codex-cli',
      { McpServer },
    );
    await withClient(server, async (client) => {
      const personal = await client.callTool({
        name: 'task_create',
        arguments: { subject: 'personal task' },
      });
      expect(personal.isError).not.toBe(true);
      expect(structuredPayload(personal)).toMatchObject({
        ownerSessionId: 'caller-a',
        subject: 'personal task',
        teamId: null,
      });

      const team = await client.callTool({
        name: 'task_create',
        arguments: { subject: 'team task', teamId: 'team-a' },
      });
      expect(team.isError).not.toBe(true);

      const denied = await createServerCoreMcpServer(
        host,
        () => 'caller-b',
        'codex-cli',
        { McpServer },
      );
      await withClient(denied, async (other) => {
        const result = await other.callTool({
          name: 'task_create',
          arguments: { subject: 'forbidden', teamId: 'team-a' },
        });
        expect(result.isError).toBe(true);
        expect(textPayload(result).error).toContain('not an active member');
      });

      records.set('caller-a', session('caller-a', host.workspaceRoot, 'closed'));
      const afterClose = await client.callTool({ name: 'task_list', arguments: {} });
      expect(afterClose.isError).toBe(true);
      expect(textPayload(afterClose).error).toContain('unavailable');
      expect(changes.map((change) => change.kind)).toEqual([
        'task.created',
        'task.created',
      ]);
    });
  });

  it('routes spawn_session through the authenticated Core caller with a relative cwd', async () => {
    const { host, spawn } = harness();
    const server = await createServerCoreMcpServer(
      host,
      () => 'caller-a',
      'codex-cli',
      { McpServer },
    );
    await withClient(server, async (client) => {
      const result = await client.callTool({
        name: 'spawn_session',
        arguments: {
          adapter: 'codex-cli',
          cwd: 'project-a',
          prompt: 'Inspect the project',
          displayName: 'Reviewer',
          agentName: 'reviewer-codex',
        },
      });
      expect(result.isError).not.toBe(true);
      expect(structuredPayload(result)).toMatchObject({
        sessionId: 'spawned-a',
        cwd: 'project-a',
        displayName: 'Reviewer',
        agentName: 'reviewer-codex',
      });
      expect(spawn).toHaveBeenCalledWith('caller-a', expect.objectContaining({
        cwd: 'project-a',
        agentName: 'reviewer-codex',
      }));
      const rejected = await client.callTool({
        name: 'spawn_session',
        arguments: { adapter: 'codex-cli', cwd: '/host/path', prompt: 'escape' },
      });
      expect(rejected.isError).toBe(true);
      expect(spawn).toHaveBeenCalledTimes(1);
    });
  });

  it('routes hand_off_session through the authenticated caller without exposing host cwd', async () => {
    const { handOff, host } = harness();
    const server = await createServerCoreMcpServer(
      host,
      () => 'caller-a',
      'codex-cli',
      { McpServer },
    );
    await withClient(server, async (client) => {
      const result = await client.callTool({
        name: 'hand_off_session',
        arguments: { prompt: 'Continue remotely', cwd: 'project-a' },
      });
      expect(result.isError).not.toBe(true);
      expect(structuredPayload(result)).toMatchObject({
        sessionId: 'successor-a',
        cwd: 'project-a',
        callerClosed: 'ok',
      });
      expect(handOff).toHaveBeenCalledWith('caller-a', {
        prompt: 'Continue remotely',
        cwd: 'project-a',
      });
    });
  });

  it('keeps Issue cwd and source-lineage authority inside the Workspace', async () => {
    const { changes, host, issues, workspaceRoot } = harness();
    const server = await createServerCoreMcpServer(
      host,
      () => 'caller-a',
      'codex-cli',
      { McpServer },
    );
    await withClient(server, async (client) => {
      const escape = await client.callTool({
        name: 'report_issue',
        arguments: {
          title: 'escape',
          description: 'must fail',
          cwd: '..',
        },
      });
      expect(escape.isError).toBe(true);
      expect(textPayload(escape).error).toContain('escapes the Workspace');

      const created = await client.callTool({
        name: 'report_issue',
        arguments: {
          title: 'Remote issue',
          description: 'bounded evidence',
          cwd: '.',
        },
      });
      expect(created.isError).not.toBe(true);
      const createdPayload = structuredPayload(created);
      expect(createdPayload).toMatchObject({ cwd: '.', sourceSessionId: 'caller-a' });
      const issueId = String(createdPayload.id);
      expect(issues.get(issueId)?.cwd).toBe(workspaceRoot);

      const denied = await createServerCoreMcpServer(
        host,
        () => 'caller-b',
        'codex-cli',
        { McpServer },
      );
      await withClient(denied, async (other) => {
        const result = await other.callTool({
          name: 'append_issue_context',
          arguments: { issueId, additionalContext: 'not owned' },
        });
        expect(result.isError).toBe(true);
        expect(textPayload(result).error).toContain('current owner');
      });

      const appended = await client.callTool({
        name: 'append_issue_context',
        arguments: { issueId, additionalContext: 'new evidence' },
      });
      expect(appended.isError).not.toBe(true);
      expect(structuredPayload(appended).appendices).toHaveLength(1);
      expect(changes.map((change) => change.kind)).toEqual([
        'issue.created',
        'issue.updated',
      ]);
    });
  });
});
