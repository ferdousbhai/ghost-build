import { useStore } from '@nanostores/react';
import { DownloadIcon, MoonIcon, SunIcon } from '@radix-ui/react-icons';
import { workbenchStore } from '~/lib/stores/workbench.client';
import { themeStore, toggleTheme } from '~/lib/stores/theme';
import { Button } from '@ui/Button';
import { MenuItem } from '@ui/Menu';

export function DownloadButton() {
  return (
    <Button
      onClick={() => workbenchStore.downloadZip()}
      variant="neutral"
      size="xs"
      aria-label="Download code"
      tip="Download code"
    >
      <DownloadIcon />
      <span>Download Code</span>
    </Button>
  );
}

export function MobileProjectMenuItems() {
  const theme = useStore(themeStore);

  return (
    <>
      <MenuItem action={() => void workbenchStore.downloadZip()}>
        <DownloadIcon />
        Download code
      </MenuItem>
      <MenuItem action={toggleTheme}>
        {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
        {theme === 'dark' ? 'Use light theme' : 'Use dark theme'}
      </MenuItem>
    </>
  );
}
