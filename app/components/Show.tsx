import { api } from '~/lib/cloudflare/data-api';
import type { SocialShare } from '~/lib/cloudflare/data-api';
import { Button } from '@ui/Button';
import { useQuery } from '~/lib/cloudflare/data-hooks';
import { type FC } from 'react';
import { classNames } from '~/utils/classNames';

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
    return <div className="p-4">Loading...</div>;
  }
  return <ShowInner share={share} {...props} />;
};

const ShowInner: FC<ShowInnerProps> = ({ share, className }) => {
  const ghostbuildIcon = <img src="/favicon.svg" alt="" className="size-5" />;

  return (
    <div className={classNames('mx-auto flex w-full flex-col gap-2 p-4 md:max-w-3xl min-h-screen', className)}>
      <div className="mb-1 grid w-full grid-cols-1 items-center gap-2 md:grid-cols-[1fr_auto]">
        <h1 className="m-0 truncate text-left text-lg font-semibold md:text-xl">{share.description}</h1>
        <div className="flex flex-wrap justify-end gap-2">
          <Button href="/" variant="primary" className="ml-2">
            Try Ghostbuild
          </Button>
          <Button
            href={`/create/${share.code}`}
            variant="neutral"
            className="flex items-center gap-2"
            icon={ghostbuildIcon}
            tip="Clone this app into your Ghostbuild project."
          >
            <span>Clone in Ghostbuild</span>
          </Button>
        </div>
      </div>
      <div
        className={classNames(
          'relative overflow-hidden rounded-lg border border-bolt-elements-background-depth-3',
          'min-h-[300px] max-h-[50vh]',
        )}
        style={{ background: '#fff' }}
      >
        {share.thumbnailUrl && (
          <div className="group relative size-full min-h-[300px]">
            <img
              src={share.thumbnailUrl}
              alt="App thumbnail"
              className="size-full object-contain"
              crossOrigin="anonymous"
              style={{ background: '#fff' }}
            />
          </div>
        )}
      </div>

      <div className="text-center">
        <a
          href="https://dash.cloudflare.com/sign-up"
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-blue-500 hover:text-blue-600"
        >
          Sign up for Cloudflare to build your own app
        </a>
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
