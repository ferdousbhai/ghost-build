// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseChat } from './BaseChat.client';

const mocks = vi.hoisted(() => ({
  chatId: 'chat-1',
  userId: 'user-1' as string | null | undefined,
  currentSubchatIndex: 0,
  createSubchat: vi.fn(),
  renameSubchat: vi.fn(),
  refreshSubchats: vi.fn(),
  renameHandler: undefined as ((title: string) => Promise<boolean>) | undefined,
}));

vi.mock('@nanostores/react', () => ({ useStore: () => mocks.currentSubchatIndex }));
vi.mock('~/lib/stores/chatId', () => ({ useChatId: () => mocks.chatId }));
vi.mock('~/lib/stores/userId', () => ({ useUserIdOrNullOrLoading: () => mocks.userId }));
vi.mock('~/lib/stores/subchats', () => ({
  subchatIndexStore: {
    get: () => mocks.currentSubchatIndex,
    set: (value: number) => {
      mocks.currentSubchatIndex = value;
    },
  },
  useIsSubchatLoaded: () => true,
}));
vi.mock('~/lib/cloudflare/data-hooks', () => ({
  useMutation: (path: string) => (path === 'subchats.setDescription' ? mocks.renameSubchat : mocks.createSubchat),
  refreshSubchats: mocks.refreshSubchats,
}));
vi.mock('./SubchatBar', () => ({
  SubchatBar: ({ handleRenameSubchat }: { handleRenameSubchat: (title: string) => Promise<boolean> }) => {
    mocks.renameHandler = handleRenameSubchat;
    return null;
  },
}));
vi.mock('./MessageInput', () => ({ MessageInput: () => null }));
vi.mock('./Messages.client', () => ({ Messages: () => null }));
vi.mock('./DisabledChatMessageSheet', () => ({ DisabledChatMessageSheet: () => null }));
vi.mock('./HomeIntro.client', () => ({ HomeIntro: () => null }));
vi.mock('./StreamingIndicator', () => ({ default: () => null }));
vi.mock('./DeploymentStatus.client', () => ({ DeploymentStatus: () => null }));
vi.mock('~/components/workbench/Workbench.client', () => ({ Workbench: () => null }));
vi.mock('~/lib/hooks/useWorkspaceSwipe', () => ({ useWorkspaceSwipe: () => ({}) }));
vi.mock('~/lib/hooks/useViewport', () => ({ default: () => false }));
vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  MotionConfig: ({ children }: { children: React.ReactNode }) => children,
  motion: { div: 'div' },
}));

let root: Root | undefined;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.chatId = 'chat-1';
  mocks.userId = 'user-1';
  mocks.currentSubchatIndex = 0;
  mocks.createSubchat.mockReset();
  mocks.renameSubchat.mockReset();
  mocks.refreshSubchats.mockReset().mockResolvedValue(undefined);
  mocks.renameHandler = undefined;
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = undefined;
  }
  document.body.replaceChildren();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe('BaseChat rename', () => {
  it('refreshes and reports success when the renamed chat becomes stale', async () => {
    const renameRequest = deferred<void>();
    mocks.renameSubchat.mockReturnValue(renameRequest.promise);
    const onSubchatTitleChange = vi.fn();

    await act(async () => root?.render(<TestChat onSubchatTitleChange={onSubchatTitleChange} />));
    const rename = mocks.renameHandler;
    expect(rename).toBeTypeOf('function');

    let result!: Promise<boolean>;
    act(() => {
      result = rename?.('Renamed chat') ?? Promise.resolve(false);
    });
    mocks.chatId = 'chat-2';
    await act(async () => root?.render(<TestChat onSubchatTitleChange={onSubchatTitleChange} />));

    await act(async () => renameRequest.resolve());
    await expect(result).resolves.toBe(true);
    expect(mocks.refreshSubchats).toHaveBeenCalledWith({ chatId: 'chat-1', sessionId: 'user-1' });
    expect(onSubchatTitleChange).not.toHaveBeenCalled();
  });
});

function TestChat({ onSubchatTitleChange }: { onSubchatTitleChange: (subchatIndex: number, title: string) => void }) {
  return (
    <BaseChat
      messageRef={undefined}
      scrollRef={undefined}
      showChat
      chatStarted
      onStop={() => undefined}
      onSend={() => Promise.resolve(true)}
      sendMessageInProgress={false}
      streamStatus="ready"
      isRecovering={false}
      currentError={undefined}
      buildProgress={null}
      messages={[]}
      disabledReason={null}
      runtimeNotice={null}
      onSubchatTitleChange={onSubchatTitleChange}
    />
  );
}
