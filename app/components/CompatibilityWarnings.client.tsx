import { chooseExperience } from '~/utils/experienceChooser';
import { Button } from '@ui/Button';
import { useState } from 'react';

export function CompatibilityWarnings() {
  const [dismissed, setDismissed] = useState(
    () => typeof localStorage !== 'undefined' && localStorage.getItem('hasDismissedMobileWarning') === 'true',
  );
  const experience = chooseExperience(navigator.userAgent, window.crossOriginIsolated);

  if (experience === 'the-real-thing' || dismissed) {
    return null;
  }

  const dismiss = () => {
    if (experience === 'mobile-warning') {
      alert(
        'Hey! 👋\n\n' +
          "We're serious, mobile and tablet experiences really are not supported. At all.\n\n" +
          "We'd love to hear feedback about how it goes, but please use the in-app feedback button instead of emailing support.\n\n" +
          "For the best experience, please use desktop Chrome or Firefox. We won't bother you again on this device. Good luck!",
      );
      localStorage.setItem('hasDismissedMobileWarning', 'true');
    }
    setDismissed(true);
  };

  if (experience === 'mobile-warning') {
    return (
      <div className="border-neutral-3 bg-background-secondary/70 text-content-secondary my-3 text-balance rounded-lg border p-4 text-center shadow-sm backdrop-blur">
        <h3 className="text-content-primary text-base font-semibold">Best on a desktop browser</h3>
        <p className="mx-auto my-2 max-w-2xl text-sm leading-6">
          Ghostbuild uses{' '}
          <a
            href="https://webcontainers.io/guides/browser-support#web-platform-requirements"
            className="font-medium text-bolt-elements-messages-linkColor hover:underline"
          >
            WebContainers
          </a>{' '}
          and needs cross-origin isolation for the full build experience.
        </p>
        <div className="text-content-secondary mt-3 text-center">
          <Button onClick={dismiss} className="max-w-full text-wrap">
            Let me use it even though my device is not supported
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="border-neutral-3 bg-background-secondary/70 text-content-secondary my-3 text-balance rounded-lg border p-4 text-center shadow-sm backdrop-blur">
      <div className="mx-auto max-w-2xl">
        {experience === 'marketing-page-only-for-mobile' ? (
          <>
            <h3 className="text-content-primary text-base font-semibold">Grab your laptop</h3>
            <p className="my-2 text-sm leading-6">
              Ghostbuild supports desktop Firefox, Chrome, and Chromium-based browsers.
            </p>
          </>
        ) : experience === 'marketing-page-only-for-desktop-safari' ? (
          <>
            <h3 className="text-content-primary text-base font-semibold">Use Chrome or Firefox for the builder</h3>
            <p className="my-2 text-sm leading-6">
              Ghostbuild uses{' '}
              <a
                href="https://webcontainers.io/guides/browser-support#web-platform-requirements"
                className="font-medium text-bolt-elements-messages-linkColor hover:underline"
              >
                WebContainers
              </a>{' '}
              and needs browser support for cross-origin isolation.
            </p>
          </>
        ) : (
          <>
            <h3 className="text-content-primary text-base font-semibold">Cross-origin isolation is not active</h3>
            <p className="my-2 text-sm leading-6">
              Use a configured production domain with desktop Chrome or Firefox for the full Ghostbuild experience.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
