import { useState } from 'react';
import { ArrowLeftIcon } from '@radix-ui/react-icons';
import { BrandLink } from '~/components/BrandLink';
import { Button } from '@ui/Button';
import { signInWithCloudflare } from '~/lib/auth-client';
import { TrustLinks } from '~/components/trust/TrustLinks';

export function CloudflareSignInPrompt({
  eyebrow = 'Cloudflare account required',
  title,
  description,
}: {
  eyebrow?: string;
  title: string;
  description: string;
}) {
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = async () => {
    setConnecting(true);
    setError(null);
    try {
      await signInWithCloudflare(window.location.href);
    } catch (connectionError) {
      setError(connectionError instanceof Error ? connectionError.message : 'Unable to connect Cloudflare.');
      setConnecting(false);
    }
  };

  return (
    <div className="app-page-shell flex min-h-full items-center px-4 py-10">
      <section className="app-error-card app-card mx-auto" aria-labelledby="cloudflare-sign-in-heading">
        <BrandLink />
        <p className="app-page-eyebrow mt-8">{eyebrow}</p>
        <h1 id="cloudflare-sign-in-heading" className="app-page-title !text-[clamp(34px,6vw,52px)]">
          {title}
        </h1>
        <p className="app-page-lede">{description}</p>
        {error && (
          <p className="mt-4 text-sm text-content-error" role="alert">
            {error}
          </p>
        )}
        <div className="mt-7 flex flex-wrap gap-3">
          <Button loading={connecting} onClick={() => void connect()}>
            Connect Cloudflare
          </Button>
          <Button href="/" variant="neutral" icon={<ArrowLeftIcon aria-hidden />}>
            Back to Ghostbuild
          </Button>
        </div>
        <p className="mt-6 text-xs leading-relaxed text-content-tertiary">
          By connecting Cloudflare, you authorize the account access described in our{' '}
          <a href="/privacy" className="underline underline-offset-4">
            Privacy notice
          </a>{' '}
          and agree to the{' '}
          <a href="/terms" className="underline underline-offset-4">
            Terms
          </a>
          .
        </p>
        <TrustLinks className="mt-4" />
      </section>
    </div>
  );
}
