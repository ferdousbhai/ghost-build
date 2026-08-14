import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { classNames } from '~/utils/classNames';

export type ButtonVariant = 'primary' | 'neutral' | 'danger' | 'ghost';
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg';

export type ButtonVisualProps = {
  children?: ReactNode;
  className?: string;
  icon?: ReactNode;
  tip?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  inline?: boolean;
  focused?: boolean;
  loading?: boolean;
  disabled?: boolean;
  type?: ButtonHTMLAttributes<HTMLButtonElement>['type'];
};

type NativeButtonProps = ButtonVisualProps & Omit<ButtonHTMLAttributes<HTMLButtonElement>, keyof ButtonVisualProps>;

type ButtonProps = NativeButtonProps & { ref?: Ref<HTMLButtonElement> };

const variantClasses: Record<ButtonVariant, string> = {
  primary: 'bg-accent-500 text-white hover:bg-accent-600',
  danger: 'bg-red-600 text-white hover:bg-red-700',
  neutral:
    'border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-content-primary hover:bg-bolt-elements-background-depth-3',
  ghost:
    'border border-transparent bg-transparent text-content-secondary hover:bg-bolt-elements-background-depth-2 hover:text-content-primary',
};

const sizeClasses: Record<ButtonSize, string> = {
  xs: 'min-h-7 px-2 py-1 text-xs',
  sm: 'min-h-8 px-2.5 py-1.5 text-sm',
  md: 'min-h-9 px-3 py-2 text-sm',
  lg: 'min-h-10 px-4 py-2 text-base',
};

export function buttonClassNames({
  className,
  variant = 'primary',
  size = 'md',
  inline,
  focused,
}: Pick<ButtonVisualProps, 'className' | 'variant' | 'size' | 'inline' | 'focused'>) {
  return classNames(
    'gb-button inline-flex shrink-0 items-center justify-center gap-1.5 rounded-full font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 disabled:cursor-not-allowed disabled:opacity-50',
    inline ? 'w-auto' : '',
    variantClasses[variant],
    sizeClasses[size],
    focused ? 'ring-2 ring-accent-500' : '',
    className,
  );
}

export function Button({
  children,
  className,
  icon,
  tip,
  variant = 'primary',
  size = 'md',
  inline,
  focused,
  loading,
  disabled,
  type = 'button',
  ref,
  ...props
}: ButtonProps) {
  const classes = buttonClassNames({ className, variant, size, inline, focused });
  const content = (
    <>
      {loading ? (
        <span
          className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent"
          aria-hidden="true"
        />
      ) : (
        icon
      )}
      {children}
    </>
  );

  return (
    <button
      {...props}
      ref={ref}
      type={type}
      className={classes}
      title={tip ?? props.title}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
    >
      {content}
    </button>
  );
}
