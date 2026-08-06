import { Link } from '@tanstack/react-router';
import type { ComponentProps, ReactNode } from 'react';
import { buttonClassNames, type ButtonSize, type ButtonVariant } from './primitives/Button';

type LinkButtonProps = Omit<ComponentProps<typeof Link>, 'children' | 'className'> & {
  children?: ReactNode;
  className?: string;
  icon?: ReactNode;
  tip?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  inline?: boolean;
};

export function LinkButton({
  children,
  className,
  icon,
  tip,
  variant = 'primary',
  size = 'md',
  inline,
  ...props
}: LinkButtonProps) {
  return (
    <Link {...props} className={buttonClassNames({ className, variant, size, inline })} title={tip}>
      {icon}
      {children}
    </Link>
  );
}
