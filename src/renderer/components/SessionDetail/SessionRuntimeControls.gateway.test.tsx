// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionConsoleCapabilitiesFixture } from '@contracts/session-console-capabilities.fixture';
import type { SessionRecord } from '@shared/types';
import type { RemoteHostJsonObject } from '@shared/remote-host';
import { SessionRuntimeControls } from './composer-sdk/SessionRuntimeControls';
import { RemoteSessionRuntimeControls } from './RemoteSessionRuntimeControls';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

interface Values {
  provider: string;
  model: string;
  thinking: string;
}

const initial: Values = { provider: 'gateway-old', model: 'old-model', thinking: 'low' };
const resolved: Values = { ...initial, provider: 'gateway-a' };

async function mountControls(mode: 'local' | 'remote', save: (patch: RemoteHostJsonObject) => Promise<void>) {
  window.api.setSessionModelOptions = vi.fn((_adapter, _session, patch) => save(patch));
  const optionSchema = sessionConsoleCapabilitiesFixture('codex-cli').create.options;
  const schema = { ...optionSchema, provider: {
    ...optionSchema.provider, allowedValues: ['gateway-old', 'gateway-a', 'gateway-b'],
  } };
  const controls = (values: Values, identity = 'session-a') => mode === 'local'
    ? <SessionRuntimeControls session={{
        id: identity, agentId: 'codex-cli', cwd: '/project', title: 'Codex', source: 'sdk',
        lifecycle: 'active', activity: 'idle', startedAt: 1, lastEventAt: 1,
        endedAt: null, archivedAt: null, runtimeProvider: values.provider,
        model: values.model, thinking: values.thinking,
      } as SessionRecord} />
    : <RemoteSessionRuntimeControls
        adapterId="codex-cli" identity={identity} busy={false} canWrite values={{ ...values }}
        optionSchema={schema} onApply={save}
      />;
  const view = render(controls(initial));
  await act(async () => {});
  fireEvent.click(screen.getByText('模型网关、模型与思考程度'));
  return { update: (values: Values, identity?: string) => view.rerender(controls(values, identity)) };
}

function chooseGateway(name: string): void {
  fireEvent.click(screen.getByLabelText('模型网关'));
  fireEvent.click(screen.getByRole('option', { name }));
}

function displayedModel(): string {
  return (screen.getByLabelText('模型') as HTMLInputElement).value;
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      listCodexGatewayProfiles: vi.fn().mockResolvedValue([
        { id: 'gateway-old' }, { id: 'gateway-a' }, { id: 'gateway-b' },
      ]),
    },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(window, 'api');
});

describe.each(['local', 'remote'] as const)('%s runtime Gateway model presentation', (mode) => {
  it('preserves model and thinking in the display and Gateway persistence payload', async () => {
    const pending = deferred();
    const save = vi.fn(() => pending.promise);
    const view = await mountControls(mode, save);
    chooseGateway('gateway-a');
    await act(async () => {});
    expect(save).toHaveBeenCalledWith({ provider: 'gateway-a', model: 'old-model', thinking: 'low' });
    expect(displayedModel()).toBe('old-model');
    view.update(resolved);
    expect(displayedModel()).toBe('old-model');
    await act(async () => pending.resolve());
    expect(displayedModel()).toBe('old-model');
    expect(screen.getByLabelText('思考程度').textContent).toContain('LOW');
  });

  it('keeps the model unchanged through a slow save and later authoritative metadata', async () => {
    const pending = deferred();
    const view = await mountControls(mode, () => pending.promise);
    chooseGateway('gateway-a');
    await act(() => vi.advanceTimersByTimeAsync(149));
    expect(screen.queryByText('正在更新模型配置…')).toBeNull();
    expect(displayedModel()).toBe('old-model');
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(displayedModel()).toBe('old-model');
    await act(async () => pending.resolve());
    expect(displayedModel()).toBe('old-model');
    view.update(resolved);
    expect(displayedModel()).toBe('old-model');
    expect(screen.queryByText('正在更新模型配置…')).toBeNull();
  });

  it('does not let an older Gateway completion overwrite a newer pending choice', async () => {
    const first = deferred();
    const second = deferred();
    const save = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const view = await mountControls(mode, save);
    chooseGateway('gateway-a');
    await act(async () => {});
    chooseGateway('gateway-b');
    view.update(resolved);
    await act(async () => first.resolve());
    expect(displayedModel()).toBe('old-model');
    expect(save).toHaveBeenLastCalledWith({ provider: 'gateway-b', model: 'old-model', thinking: 'low' });
    view.update({ ...resolved, provider: 'gateway-b' });
    await act(async () => second.resolve());
    expect(displayedModel()).toBe('old-model');
  });

  it('keeps a newer explicit model edit and sends it after the Gateway save', async () => {
    const first = deferred();
    const second = deferred();
    const save = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const view = await mountControls(mode, save);
    chooseGateway('gateway-a');
    await act(async () => {});
    fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'custom-model' } });
    view.update(resolved);
    await act(() => vi.advanceTimersByTimeAsync(250));
    await act(async () => first.resolve());
    expect(displayedModel()).toBe('custom-model');
    expect(save).toHaveBeenLastCalledWith({ provider: 'gateway-a', model: 'custom-model', thinking: 'low' });
    await act(async () => second.resolve());
    expect(displayedModel()).toBe('custom-model');
    expect(screen.queryByText('正在更新模型配置…')).toBeNull();
  });

  it('keeps the model unchanged when a Gateway save fails', async () => {
    const pending = deferred();
    await mountControls(mode, () => pending.promise);
    chooseGateway('gateway-a');
    await act(() => vi.advanceTimersByTimeAsync(150));
    await act(async () => pending.reject(new Error('Gateway unavailable')));
    expect(displayedModel()).toBe('old-model');
    expect(screen.queryByText('正在更新模型配置…')).toBeNull();
    expect(screen.getByText(/Gateway unavailable/)).toBeTruthy();
  });

  it('keeps an old Gateway acknowledgement from changing a replacement session', async () => {
    const pending = deferred();
    const view = await mountControls(mode, () => pending.promise);
    chooseGateway('gateway-a');
    await act(async () => {});
    view.update({ ...initial, model: 'replacement-model' }, 'session-b');
    await act(() => vi.advanceTimersByTimeAsync(150));
    expect(displayedModel()).toBe('replacement-model');
    expect(screen.queryByText('正在更新模型配置…')).toBeNull();
    await act(async () => pending.resolve());
    expect(displayedModel()).toBe('replacement-model');
  });

  it('preserves a just-edited model when switching back to the native Gateway', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    await mountControls(mode, save);
    fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'custom-model' } });
    chooseGateway('留空使用 config.toml');
    await act(async () => {});
    expect(save).toHaveBeenCalledWith({ provider: null, model: 'custom-model', thinking: 'low' });
    expect(displayedModel()).toBe('custom-model');
  });
});
