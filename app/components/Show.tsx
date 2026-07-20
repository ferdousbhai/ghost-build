import { api } from '~/lib/cloudflare/data-api';
import type { SocialShare } from '~/lib/cloudflare/data-api';
import { Button } from '@ui/Button';
import { useQuery } from '~/lib/cloudflare/data-hooks';
import { type FC } from 'react';
import { classNames } from '~/utils/classNames';
import { PlusIcon } from '@radix-ui/react-icons';
import { Loading } from '~/components/Loading';
import { BrandLink } from '~/components/BrandLink';

interface ShowInnerProps {
  share: SocialShare;
  className?: string;
}

interface StaticShowProps extends Omit<ShowInnerProps, 'share'> {
  share: SocialShare;
}

interface CodeShowProps extends Omit<ShowInnerProps, 'share'> {
  code: string;
}

type ShowProps = StaticShowProps | CodeShowProps;

const StaticShow: FC<StaticShowProps> = ({ share, ...props }) => {
  return <ShowInner share={share} {...props} />;
};

const CodeShow: FC<CodeShowProps> = ({ code, ...props }) => {
  const share = useQuery(api.socialShare.getSocialShare, { code });
  if (share === undefined) {
    return <Loading message="Loading the shared project…" />;
  }
  return <ShowInner share={share} {...props} />;
};

const ShowInner: FC<ShowInnerProps> = ({ share, className }) => {
  return (
    <div className={classNames('app-page-shell', className)}>
      <div className="app-page-container">
        <nav className="app-page-nav" aria-label="Shared project navigation">
          <BrandLink />
          <Button href="/" variant="neutral" size="sm">
            <span>Build your own</span>
          </Button>
        </nav>

        <article aria-labelledby="shared-project-title">
          <header className="grid gap-6 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
            <div className="min-w-0">
              <p className="app-page-eyebrow">Built with Ghostbuild</p>
              <h1 id="shared-project-title" className="app-page-title break-words">
                {share.description || 'Shared Ghostbuild project'}
              </h1>
            </div>
            <Button
              href={`/create/${share.code}`}
              size="lg"
              icon={<PlusIcon aria-hidden />}
              tip="Clone this app into your Ghostbuild project."
            >
              Clone in Ghostbuild
            </Button>
          </header>

          <div className="app-card mt-8 overflow-hidden p-2">
            <div className="flex min-h-10 items-center gap-2 border-b border-bolt-elements-borderColor px-3 text-xs font-bold text-content-secondary">
              <span className="size-2 rounded-full bg-[var(--ghost-home-accent-2)]" aria-hidden />
              Live project preview
            </div>
            <div className="relative min-h-[320px] overflow-hidden rounded-b-md bg-white md:min-h-[440px]">
              {share.thumbnailUrl ? (
                <div className="group relative size-full min-h-[320px] md:min-h-[440px]">
                  <img
                    src={share.thumbnailUrl}
                    alt={`${share.description || 'Shared app'} preview`}
                    className="absolute inset-0 size-full object-contain"
                    crossOrigin="anonymous"
                    style={{ background: '#fff' }}
                  />
                </div>
              ) : (
                <div className="flex min-h-[320px] items-center justify-center px-6 text-center text-sm text-gray-600 md:min-h-[440px]">
                  A preview image is not available for this project.
                </div>
              )}
            </div>
          </div>

          <footer className="mt-5 flex flex-col gap-3 text-sm text-content-secondary sm:flex-row sm:items-center sm:justify-between">
            <span>Want to keep building? Clone the project and edit every part of it.</span>
            <a
              href="https://dash.cloudflare.com/sign-up"
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-content-link hover:underline"
            >
              Create a Cloudflare account
            </a>
          </footer>
        </article>
      </div>
    </div>
  );
};

export const Show: FC<ShowProps> = (props) => {
  if ('share' in props) {
    return <StaticShow {...props} />;
  }
  if ('code' in props) {
    return <CodeShow {...props} />;
  }
  throw new Error('Must pass share or code to Show component');
};
