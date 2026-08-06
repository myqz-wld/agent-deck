import { getProcessRunId } from '@main/utils/run-context';
import { AgentDeckMcpStartupObserver } from './mcp-startup-observer';

/** Desktop process-identity adapter for the host-neutral MCP startup observer. */
export function createAgentDeckMcpStartupObserver(): AgentDeckMcpStartupObserver {
  return new AgentDeckMcpStartupObserver(getProcessRunId());
}
