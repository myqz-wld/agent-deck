import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import {
  methods,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import { describe, expect, it, vi } from 'vitest';

import { withTimeout } from '@main/adapters/grok-build/acp-process';
import {
  createProductionServerCoreProviderGrokContainer,
} from '@hosts/server-core/provider-grok-container-production';
import { createProductionProviderSessionSupervisorHost } from './production';
import {
  NodeProviderSessionAttachmentProcess,
  type ProviderSessionAttachmentProcessPort,
} from './node-oci-attachment';
import { NodeProviderSessionProcess } from './node-oci-process';
import {
  fakeCompletion,
  fakeResponsesCompletion,
  fakeResponsesToolCall,
  fakeToolCall,
  liveToolName,
  liveToolProperties,
  type LiveScenario,
  type LiveUpstreamTool,
} from './live-colima-fake-upstream';

const LIVE = process.env.AGENT_DECK_PROVIDER_LIVE_ACCEPTANCE === '1';
const CANARY = 'AGENT_DECK_LIVE_CANARY_NOT_SECRET';
// Keep the identity-checked child short enough for the 103-byte portable Unix-socket bound.
const ROOT_PREFIX = 'p-';
const MANAGED_LABEL = 'io.agent-deck.managed-by=agent-deck-provider-supervisor';

interface LiveAcceptanceConfig {
  readonly acceptanceRoot: string;
  readonly docker: string;
  readonly dockerHost: string;
  readonly dockerSocketPath: string;
  readonly image: string;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() !== value || value.includes('\0')) {
    throw new Error(`${name} is required for live Provider acceptance`);
  }
  return value;
}

function canonicalDirectory(value: string, field: string): string {
  if (!isAbsolute(value) || normalize(value) !== value || value === '/' ||
      realpathSync(value) !== value) {
    throw new Error(`${field} is invalid`);
  }
  const stat = lstatSync(value);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${field} is invalid`);
  return value;
}

function canonicalExecutable(value: string): string {
  if (!isAbsolute(value) || normalize(value) !== value || realpathSync(value) !== value) {
    throw new Error('live Provider Docker executable is invalid');
  }
  const stat = lstatSync(value);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0) {
    throw new Error('live Provider Docker executable is invalid');
  }
  return value;
}

function dockerSocket(value: string): string {
  if (!value.startsWith('unix://')) throw new Error('live Provider Docker host is invalid');
  const path = value.slice('unix://'.length);
  if (!isAbsolute(path) || normalize(path) !== path || realpathSync(path) !== path) {
    throw new Error('live Provider Docker socket is invalid');
  }
  const stat = lstatSync(path);
  if (!stat.isSocket() || stat.isSymbolicLink()) {
    throw new Error('live Provider Docker socket is invalid');
  }
  return path;
}

function liveConfig(): LiveAcceptanceConfig {
  const dockerHost = requiredEnvironment('AGENT_DECK_PROVIDER_LIVE_DOCKER_HOST');
  const image = requiredEnvironment('AGENT_DECK_PROVIDER_LIVE_IMAGE');
  if (!/^sha256:[a-f0-9]{64}$/.test(image)) {
    throw new Error('AGENT_DECK_PROVIDER_LIVE_IMAGE must be an immutable image ID');
  }
  return Object.freeze({
    acceptanceRoot: canonicalDirectory(
      requiredEnvironment('AGENT_DECK_PROVIDER_LIVE_ROOT'),
      'live Provider acceptance root',
    ),
    docker: canonicalExecutable(requiredEnvironment('AGENT_DECK_PROVIDER_LIVE_DOCKER')),
    dockerHost,
    dockerSocketPath: dockerSocket(dockerHost),
    image,
  });
}

function docker(config: LiveAcceptanceConfig, args: readonly string[]): string {
  return execFileSync(config.docker, [...args], {
    encoding: 'utf8',
    env: { DOCKER_HOST: config.dockerHost, LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin' },
  });
}

function managedContainers(config: LiveAcceptanceConfig): Set<string> {
  return new Set(docker(config, [
    'container', 'ls', '--all', '--filter', `label=${MANAGED_LABEL}`, '--format={{.Names}}',
  ]).trim().split('\n').filter(Boolean));
}

function allowOnce(request: RequestPermissionRequest): RequestPermissionResponse {
  const option = request.options.find((candidate) => candidate.kind === 'allow_once');
  return option
    ? { outcome: { outcome: 'selected', optionId: option.optionId } }
    : { outcome: { outcome: 'cancelled' } };
}

function createAcceptanceRoot(parent: string): string {
  const root = realpathSync(mkdtempSync(join(parent, ROOT_PREFIX)));
  for (const path of [
    join(root, 'private'),
    join(root, 'private', 'broker'),
    join(root, 'private', 'state'),
    join(root, 'private', 'transport'),
    join(root, 'credentials'),
    join(root, 'workspace'),
    join(root, 'adjacent'),
  ]) {
    mkdirSync(path, { mode: 0o700 });
    chmodSync(path, 0o700);
  }
  const credentialPath = join(root, 'credentials', 'grok-auth.json');
  writeFileSync(credentialPath, JSON.stringify({
    'xai::cached': {
      auth_mode: 'oauth',
      expires_at: '2099-01-01T00:00:00Z',
      key: CANARY,
    },
  }), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  chmodSync(credentialPath, 0o600);
  writeFileSync(join(root, 'adjacent', 'outside.txt'), 'ADJACENT_MUST_STAY_HIDDEN\n', {
    encoding: 'utf8', flag: 'wx', mode: 0o600,
  });
  return root;
}

function removeAcceptanceRoot(parent: string, root: string): void {
  const relationPath = relative(parent, root);
  const stat = lstatSync(root, { throwIfNoEntry: false });
  if (!stat) return;
  if (dirname(root) !== parent || relationPath.includes(sep) ||
      !basename(root).startsWith(ROOT_PREFIX) || !stat.isDirectory() ||
      stat.isSymbolicLink() || realpathSync(root) !== root) {
    throw new Error('live Provider acceptance cleanup identity changed');
  }
  rmSync(root, { force: false, maxRetries: 0, recursive: true });
}

describe.skipIf(!LIVE)('live Colima Provider Grok acceptance', () => {
  it('runs real Grok ACP through the private supervisor and credential broker', async () => {
    const config = liveConfig();
    const root = createAcceptanceRoot(config.acceptanceRoot);
    const workspace = realpathSync(join(root, 'workspace'));
    const adjacentCanary = join(root, 'adjacent', 'outside.txt');
    const nonce = randomUUID().replaceAll('-', '').slice(0, 16);
    const instanceId = `live-${nonce}`;
    const priorContainers = managedContainers(config);
    const brokerFailures: Array<{ readonly code: string; readonly path: string }> = [];
    const upstream: Array<{ headers: Record<string, string>; url: string; body: string }> = [];
    let currentScenario: LiveScenario | null = null;
    const fetchFn = vi.fn<typeof fetch>(async (url, init) => {
      const responsesProtocol = new URL(String(url)).pathname === '/v1/responses';
      const rawBody = String(init?.body ?? '');
      upstream.push({
        body: rawBody,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        url: String(url),
      });
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(rawBody) as Record<string, unknown>; } catch {}
      const tools = Array.isArray(body.tools) ? body.tools as LiveUpstreamTool[] : [];
      if (!currentScenario || tools.length === 0) {
        return responsesProtocol
          ? fakeResponsesCompletion()
          : fakeCompletion('AUXILIARY_OK', 'auxiliary');
      }
      const toolCallId = `live-${currentScenario.kind}-tool`;
      if (currentScenario.issued && rawBody.includes(toolCallId)) {
        currentScenario.resultBody = rawBody;
        currentScenario = null;
        return responsesProtocol ? fakeResponsesCompletion('LIVE_OK') : fakeCompletion();
      }
      if (currentScenario.issued) {
        return responsesProtocol
          ? fakeResponsesCompletion()
          : fakeCompletion('AUXILIARY_OK', 'auxiliary');
      }
      const tool = tools.find((candidate) => {
        const keys = Object.keys(liveToolProperties(candidate));
        const hasPath = keys.some((key) =>
          ['file_path', 'filename', 'path', 'target_file'].includes(key));
        const hasContent = keys.some((key) =>
          ['content', 'data', 'text', 'new_string'].includes(key));
        return currentScenario?.kind === 'write'
          ? hasPath && hasContent && /write|create|edit/i.test(liveToolName(candidate))
          : hasPath && /read/i.test(liveToolName(candidate));
      });
      if (!tool && responsesProtocol) return fakeResponsesCompletion();
      if (!tool) throw new Error(`live Grok did not publish one ${currentScenario.kind} tool`);
      currentScenario.issued = true;
      return responsesProtocol
        ? fakeResponsesToolCall(tool, currentScenario)
        : fakeToolCall(tool, currentScenario);
    });
    const rawProcess = new NodeProviderSessionProcess();
    const rawAttachment = new NodeProviderSessionAttachmentProcess();
    let attachmentDiagnostics = (): string => '';
    const attachmentProcess: ProviderSessionAttachmentProcessPort = {
      open: async (request) => {
        const attachment = await rawAttachment.open(request);
        attachmentDiagnostics = () => String(
          (attachment as typeof attachment & { readonly diagnostics?: string }).diagnostics ?? '',
        ).replaceAll(CANARY, '[CANARY]');
        return attachment;
      },
    };
    const host = createProductionProviderSessionSupervisorHost({
      attachmentProcess,
      brokerRoot: join(root, 'private', 'broker'),
      coreProcessId: `live-core-${nonce}`,
      desktopSocketPath: config.dockerSocketPath,
      desktopVm: 'colima',
      engine: 'docker-desktop',
      executable: config.docker,
      images: {
        'claude-code-v1': null,
        'codex-cli-v1': null,
        'grok-build-v1': config.image,
      },
      instanceId,
      maxActive: 2,
      privateRoot: join(root, 'private'),
      process: {
        run: async (request) => {
          const result = await rawProcess.run(request);
          if (result.exitCode !== 0 || result.timedOut || result.outputTruncated) {
            process.stderr.write(
              `[live-oci ${request.args.slice(0, 2).join(' ')}] ${JSON.stringify(result)}\n`,
            );
          }
          return result;
        },
      },
      stateRoot: join(root, 'private', 'state'),
      transportRuntimeDirectory: join(root, 'private', 'transport'),
      transportSocketPath: join(root, 'private', 'transport', 's.sock'),
      workspaceRoot: workspace,
    });
    let container: ReturnType<typeof createProductionServerCoreProviderGrokContainer> | null = null;
    const acceptedContainerNames = new Set<string>();
    let launched: Awaited<ReturnType<
      ReturnType<typeof createProductionServerCoreProviderGrokContainer>['processFactory']
    >> | null = null;
    let hostStopped = false;
    try {
      await host.start();
      container = createProductionServerCoreProviderGrokContainer({
        brokerRoot: join(root, 'private', 'broker'),
        credentialRoot: join(root, 'credentials'),
        fetch: fetchFn,
        instanceId,
        onInferenceFailure: (failure) => brokerFailures.push(failure),
        supervisorSocketPath: join(root, 'private', 'transport', 's.sock'),
        workspaceRoot: workspace,
      });
      await expect(container.readiness()).resolves.toMatchObject({
        available: true,
        disabledReason: null,
      });
      launched = await container.processFactory({
        applicationSessionId: `live-session-${nonce}`,
        cwd: workspace,
        sandboxProfile: 'workspace',
        onPermissionRequest: async (request) => allowOnce(request),
        onSessionUpdate: () => undefined,
      });
      expect(launched).toMatchObject({
        allowAgentDeckMcp: false,
        allowHostPathMetadata: false,
        sessionCwd: '/workspace',
      });
      expect(launched.process.authenticatedMethodId).toBe('xai.api_key');
      const created = await withTimeout(
        launched.process.connection.agent.request(methods.agent.session.new, {
          cwd: launched.sessionCwd,
          mcpServers: [],
        }),
        30_000,
        'live Grok session/new',
      );
      expect(created.sessionId).toBeTruthy();

      const newContainers = [...managedContainers(config)]
        .filter((name) => !priorContainers.has(name));
      expect(newContainers).toHaveLength(1);
      const acceptedContainerName = newContainers[0]!;
      acceptedContainerNames.add(acceptedContainerName);
      const inspection = JSON.parse(docker(config, [
        'container', 'inspect', '--', acceptedContainerName,
      ]))[0];
      expect(inspection.HostConfig).toMatchObject({
        CapDrop: ['ALL'],
        Memory: 4 * 1024 * 1024 * 1024,
        NetworkMode: 'none',
        PidsLimit: 256,
        ReadonlyRootfs: true,
      });
      expect(inspection.Config.Image).toBe(config.image);
      const encodedInspection = JSON.stringify(inspection);
      expect(encodedInspection).not.toContain(CANARY);
      expect(encodedInspection).not.toContain(join(root, 'credentials'));
      expect(encodedInspection).not.toContain(config.dockerSocketPath);
      expect(encodedInspection).not.toMatch(/\.ssh|docker\.sock|auth\.json/i);
      expect(inspection.Mounts).toEqual(expect.arrayContaining([
        expect.objectContaining({ Destination: '/workspace', RW: true }),
      ]));

      const writeText = `LIVE_WORKSPACE_WRITE_${nonce}\n`;
      const writeScenario: LiveScenario = {
        content: writeText,
        issued: false,
        kind: 'write',
        resultBody: null,
        target: '/workspace/workspace-write-canary.txt',
      };
      currentScenario = writeScenario;
      const pendingPrompt = launched.process.connection.agent.request(
        methods.agent.session.prompt,
        {
          sessionId: created.sessionId,
          prompt: [{ type: 'text', text: 'Create the requested Workspace acceptance canary.' }],
        },
      );
      for (let attempt = 0; writeScenario.resultBody === null && attempt < 800; attempt += 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }
      if (writeScenario.resultBody === null) {
        const requests = upstream.slice(-4).map(({ body, url }) => {
          let parsed: Record<string, unknown> = {};
          try { parsed = JSON.parse(body) as Record<string, unknown>; } catch {}
          const tools = Array.isArray(parsed.tools) ? parsed.tools as LiveUpstreamTool[] : [];
          return {
            bodyBytes: Buffer.byteLength(body),
            bodyKeys: Object.keys(parsed),
            toolCount: tools.length,
            tools: tools.slice(-5).map((tool) => ({
              keys: Object.keys(tool),
              name: liveToolName(tool),
              properties: Object.keys(liveToolProperties(tool)),
            })),
            url,
          };
        });
        throw new Error(`live Grok write did not retire (issued=${writeScenario.issued}): ` +
          `${attachmentDiagnostics()}\n` +
          `broker=${JSON.stringify(brokerFailures)} upstream=${JSON.stringify(requests)}`);
      }
      await expect(withTimeout(pendingPrompt, 30_000, 'live Grok write prompt'))
        .resolves.toMatchObject({ stopReason: 'end_turn' });
      const writtenCanary = join(workspace, 'workspace-write-canary.txt');
      if (!existsSync(writtenCanary)) {
        let evidence = String(writeScenario.resultBody);
        try {
          const parsed = JSON.parse(evidence) as Record<string, unknown>;
          evidence = JSON.stringify({ input: parsed.input, messages: parsed.messages });
        } catch {}
        throw new Error(`live Grok write did not reach the host: ${evidence
          .replaceAll(CANARY, '[CANARY]').slice(-4_000)}`);
      }
      expect(readFileSync(writtenCanary, 'utf8')).toBe(writeText);

      await launched.process.stop();
      launched = await container.processFactory({
        applicationSessionId: `live-readonly-${nonce}`,
        cwd: workspace,
        sandboxProfile: 'read-only',
        onPermissionRequest: async (request) => allowOnce(request),
        onSessionUpdate: () => undefined,
      });
      const readOnlyCreated = await withTimeout(
        launched.process.connection.agent.request(methods.agent.session.new, {
          cwd: launched.sessionCwd,
          mcpServers: [],
        }),
        30_000,
        'live read-only Grok session/new',
      );
      const readOnlyContainers = [...managedContainers(config)]
        .filter((name) => !priorContainers.has(name));
      expect(readOnlyContainers).toHaveLength(1);
      const readOnlyContainerName = readOnlyContainers[0]!;
      acceptedContainerNames.add(readOnlyContainerName);
      const readOnlyInspection = JSON.parse(docker(config, [
        'container', 'inspect', '--', readOnlyContainerName,
      ]))[0];
      expect(readOnlyInspection.Mounts).toEqual(expect.arrayContaining([
        expect.objectContaining({ Destination: '/workspace', RW: false }),
      ]));

      const readOnlyScenario: LiveScenario = {
        content: `MUST_NOT_WRITE_${nonce}\n`,
        issued: false,
        kind: 'write',
        resultBody: null,
        target: '/workspace/read-only-canary.txt',
      };
      currentScenario = readOnlyScenario;
      await expect(withTimeout(
        launched.process.connection.agent.request(methods.agent.session.prompt, {
          sessionId: readOnlyCreated.sessionId,
          prompt: [{ type: 'text', text: 'Attempt the read-only Workspace canary write.' }],
        }),
        30_000,
        'live read-only Grok prompt',
      )).resolves.toMatchObject({ stopReason: 'end_turn' });
      expect(readOnlyScenario.resultBody).not.toBeNull();
      expect(existsSync(join(workspace, 'read-only-canary.txt'))).toBe(false);

      const adjacentScenario: LiveScenario = {
        content: null,
        issued: false,
        kind: 'read',
        resultBody: null,
        target: adjacentCanary,
      };
      currentScenario = adjacentScenario;
      await expect(withTimeout(
        launched.process.connection.agent.request(methods.agent.session.prompt, {
          sessionId: readOnlyCreated.sessionId,
          prompt: [{ type: 'text', text: 'Attempt the adjacent-root acceptance read.' }],
        }),
        30_000,
        'live adjacent-root Grok prompt',
      )).resolves.toMatchObject({ stopReason: 'end_turn' });
      expect(adjacentScenario.resultBody).not.toContain('ADJACENT_MUST_STAY_HIDDEN');
      expect(upstream.length).toBeGreaterThanOrEqual(6);
      expect(new Set(upstream.map((request) => request.url))).toEqual(new Set([
        'https://api.x.ai/v1/responses',
        'https://cli-chat-proxy.grok.com/v1/chat/completions',
      ]));
      for (const request of upstream) {
        expect(request).toMatchObject({
          headers: { authorization: `Bearer ${CANARY}` },
        });
        expect(request.body).not.toContain(CANARY);
      }
    } finally {
      await launched?.process.stop().catch(() => undefined);
      await container?.close().catch(() => undefined);
      await host.stop();
      hostStopped = true;
      if (hostStopped) removeAcceptanceRoot(config.acceptanceRoot, root);
    }
    if (acceptedContainerNames.size !== 2) {
      throw new Error('live Provider containers were not observed');
    }
    const remaining = managedContainers(config);
    for (const name of acceptedContainerNames) expect(remaining.has(name)).toBe(false);
  }, 120_000);
});
