import { classNames } from '~/utils/classNames';

export function BrandLink({
  className,
  nameClassName,
  variant = 'page',
}: {
  className?: string;
  nameClassName?: string;
  variant?: 'page' | 'header';
}) {
  return (
    <a
      href="/"
      className={classNames({ 'app-brand-lockup': variant === 'page' }, className)}
      aria-label="Ghostbuild home"
    >
      <span className="ghostbuild-brand-mark" aria-hidden>
        <span className="ghostbuild-brand-mark__glyph">G</span>
        <span className="ghostbuild-brand-mark__spark" />
      </span>
      <span className={nameClassName}>Ghostbuild</span>
    </a>
  );
}
