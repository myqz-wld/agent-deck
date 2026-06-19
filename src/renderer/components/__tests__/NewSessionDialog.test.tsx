// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NewSessionDialog } from '../NewSessionDialog';

let chooseDirectory: ReturnType<typeof vi.fn>;
let resolveChooseDirectory: (value: string | null) => void;

beforeEach(() => {
  chooseDirectory = vi.fn(
    () =>
      new Promise<string | null>((resolve) => {
        resolveChooseDirectory = resolve;
      }),
  );
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      listAdapters: vi.fn().mockResolvedValue([
        {
          id: 'claude-code',
          displayName: 'Claude',
          capabilities: {
            canCreateSession: true,
            canSetPermissionMode: true,
          },
        },
      ]),
      chooseDirectory,
      createAdapterSession: vi.fn(),
    },
  });
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, 'api');
});

describe('NewSessionDialog directory picker', () => {
  it('dedupes repeated directory picker clicks while the native dialog is open', async () => {
    render(<NewSessionDialog open={true} onClose={vi.fn()} onCreated={vi.fn()} />);

    const chooseButton = (await screen.findByText('选择…')) as HTMLButtonElement;
    fireEvent.click(chooseButton);
    fireEvent.click(chooseButton);

    expect(chooseDirectory).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      const pendingButton = screen.getByText('选择中…') as HTMLButtonElement;
      expect(pendingButton.disabled).toBe(true);
    });

    await act(async () => {
      resolveChooseDirectory('/tmp/agent-deck');
    });

    await waitFor(() => {
      const cwdInput = screen.getByPlaceholderText('留空使用主目录 (~)') as HTMLInputElement;
      expect(cwdInput.value).toBe('/tmp/agent-deck');
    });
    const readyButton = screen.getByText('选择…') as HTMLButtonElement;
    expect(readyButton.disabled).toBe(false);
  });
});
