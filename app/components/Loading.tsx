import { Spinner } from '@ui/Spinner';

export function Loading(props: { message?: string }) {
  return (
    <div className="text-content-secondary flex h-full flex-col items-center justify-center gap-4">
      <div>
        <Spinner />
      </div>
      {props.message ?? 'Loading...'}
    </div>
  );
}
