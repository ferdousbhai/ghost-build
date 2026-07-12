import { useStore } from '@nanostores/react';
import { Button } from '@ui/Button';
import { toggleTheme } from '~/lib/stores/theme';
import { themeStore } from '~/lib/stores/theme';
import { MoonIcon, SunIcon } from '@radix-ui/react-icons';

export function ThemeCard() {
  const theme = useStore(themeStore);
  const isDark = theme === 'dark';
  return (
    <section className="app-card p-5 sm:p-6" aria-labelledby="appearance-heading">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="app-page-eyebrow">Interface</p>
          <h2 id="appearance-heading" className="app-card-title mt-2">
            Appearance
          </h2>
          <p className="app-card-copy mt-2 max-w-xl">
            Use the palette that is most comfortable for reviewing code, previews, and agent output.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className="app-status-badge">{isDark ? 'Dark theme' : 'Light theme'}</span>
          <Button
            onClick={toggleTheme}
            variant="neutral"
            icon={isDark ? <SunIcon aria-hidden /> : <MoonIcon aria-hidden />}
            aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
          >
            {isDark ? 'Use light' : 'Use dark'}
          </Button>
        </div>
      </div>
    </section>
  );
}
