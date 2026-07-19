import { memo } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { IconButton } from '~/components/ui/IconButton';
import type { PreviewInfo } from '~/lib/stores/previews';
import { Link2Icon } from '@radix-ui/react-icons';

interface PortDropdownProps {
  activePreviewIndex: number;
  setActivePreviewIndex: (index: number) => void;
  isDropdownOpen: boolean;
  setIsDropdownOpen: (value: boolean) => void;
  setHasSelectedPreview: (value: boolean) => void;
  previews: PreviewInfo[];
}

export const PortDropdown = memo(function PortDropdown({
  activePreviewIndex,
  setActivePreviewIndex,
  isDropdownOpen,
  setIsDropdownOpen,
  setHasSelectedPreview,
  previews,
}: PortDropdownProps) {
  // sort previews, preserving original index
  const sortedPreviews = previews
    .map((previewInfo, index) => ({ ...previewInfo, index }))
    .sort((a, b) => a.port - b.port);

  return (
    <DropdownMenu.Root open={isDropdownOpen} onOpenChange={setIsDropdownOpen}>
      <DropdownMenu.Trigger asChild>
        <IconButton icon={<Link2Icon />} title={isDropdownOpen ? 'Close ports menu' : 'Open ports menu'} />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={8}
          className="dropdown-animation z-port-dropdown min-w-[140px] rounded border bg-bolt-elements-background-depth-2 shadow-sm"
        >
          <DropdownMenu.Label className="border-b px-4 py-2 text-sm font-semibold text-content-primary">
            Ports
          </DropdownMenu.Label>
          <DropdownMenu.RadioGroup
            value={String(previews[activePreviewIndex]?.port ?? '')}
            onValueChange={(port) => {
              const index = previews.findIndex((preview) => String(preview.port) === port);
              if (index !== -1) {
                setActivePreviewIndex(index);
                setHasSelectedPreview(true);
              }
            }}
          >
            {sortedPreviews.map((preview) => (
              <DropdownMenu.RadioItem
                key={preview.port}
                value={String(preview.port)}
                className="flex cursor-pointer items-center px-4 py-2 outline-none hover:bg-bolt-elements-item-backgroundActive focus:bg-bolt-elements-item-backgroundActive"
              >
                <span
                  className={
                    activePreviewIndex === preview.index
                      ? 'text-bolt-elements-item-contentAccent'
                      : 'text-bolt-elements-item-contentDefault'
                  }
                >
                  {preview.port}
                </span>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
});
