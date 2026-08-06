import { classNames } from '~/utils/classNames';
import { Link } from '@tanstack/react-router';

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
    <Link
      to="/"
      reloadDocument={variant === 'header'}
      className={classNames({ 'app-brand-lockup': variant === 'page' }, className)}
      aria-label="Ghostbuild home"
    >
      <span className="ghostbuild-brand-mark" aria-hidden>
        <span className="ghostbuild-brand-mark__glyph">👻</span>
      </span>
      <span className={nameClassName}>Ghostbuild</span>
    </Link>
  );
}
