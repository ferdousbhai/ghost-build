import { useStore } from '@nanostores/react';
import { ChatBubbleIcon, CodeIcon } from '@radix-ui/react-icons';
import { Button } from '@ui/Button';
import useViewport from '~/lib/hooks/useViewport';
import { chatStore } from '~/lib/stores/chatId';
import { workbenchStore } from '~/lib/stores/workbench.client';

export function HeaderActionButtons() {
  const showWorkbench = useStore(workbenchStore.showWorkbench);
  const { showChat } = useStore(chatStore);
  const isSmallViewport = useViewport(1024);
  const canHideChat = showWorkbench || !showChat;

  return (
    <div className="flex">
      <div className="flex overflow-hidden">
        <Button
          disabled={!canHideChat || isSmallViewport} // expand button is disabled on mobile as it's not needed
          tip={!canHideChat ? 'Cannot hide chat while code is closed' : showChat ? 'Hide chat' : 'Show chat'}
          onClick={() => {
            if (canHideChat) {
              chatStore.setKey('showChat', !showChat);
            }
          }}
          variant="neutral"
          className="!size-11 !min-h-11 rounded-r-none border-r-0 !px-0 sm:!size-auto sm:!min-h-9 sm:!px-3"
          icon={<ChatBubbleIcon className="my-px" />}
          aria-label={showChat ? 'Hide chat' : 'Show chat'}
        />
        <Button
          onClick={() => {
            if (showWorkbench && !showChat) {
              chatStore.setKey('showChat', true);
            }

            workbenchStore.showWorkbench.set(!showWorkbench);
          }}
          variant="neutral"
          className="!size-11 !min-h-11 rounded-l-none !px-0 sm:!size-auto sm:!min-h-9 sm:!px-3"
          icon={<CodeIcon className="my-px" />}
          aria-label={showWorkbench ? 'Hide workbench' : 'Show workbench'}
          tip={showWorkbench ? 'Hide workbench' : 'Show workbench'}
        />
      </div>
    </div>
  );
}
