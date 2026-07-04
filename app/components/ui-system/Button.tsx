import { forwardRef, type AnchorHTMLAttributes, type ButtonHTMLAttributes, type ReactNode, type Ref } from 'react';
import { classNames } from '~/utils/classNames';

type ButtonVisualProps = {
  children?: ReactNode;
  className?: string;
  icon?: ReactNode;
  tip?: string;
  variant?: 'primary' | 'neutral' | 'danger' | string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | string;
  inline?: boolean;
  focused?: boolean;
  loading?: boolean;
  disabled?: boolean;
  type?: ButtonHTMLAttributes<HTMLButtonElement>['type'];
};

type AnchorButtonProps = ButtonVisualProps &
  Omit<AnchorHTMLAttributes<HTMLAnchorElement>, keyof ButtonVisualProps | 'href'> & {
    href: string;
  };

type NativeButtonProps = ButtonVisualProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, keyof ButtonVisualProps | 'href'> & {
    href?: undefined;
  };

type ButtonProps = AnchorButtonProps | NativeButtonProps;

const variantClasses: Record<string, string> = {
  primary: 'bg-accent-500 text-white hover:bg-accent-600',
  danger: 'bg-red-600 text-white hover:bg-red-700',
  neutral:
    'border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 text-content-primary hover:bg-bolt-elements-background-depth-3',
};

const sizeClasses: Record<string, string> = {
  xs: 'min-h-7 px-2 py-1 text-xs',
  sm: 'min-h-8 px-2.5 py-1.5 text-sm',
  md: 'min-h-9 px-3 py-2 text-sm',
  lg: 'min-h-10 px-4 py-2 text-base',
};

export const Button = forwardRef<HTMLButtonElement | HTMLAnchorElement, ButtonProps>(function Button(
  {
    children,
    className,
    icon,
    tip,
    variant = 'primary',
    size = 'md',
    inline,
    focused,
    href,
    loading,
    disabled,
    type = 'button',
    ...props
  },
  ref,
) {
  const classes = classNames(
    'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 disabled:cursor-not-allowed disabled:opacity-50',
    inline ? 'w-auto' : '',
    variantClasses[variant] ?? variantClasses.neutral,
    sizeClasses[size] ?? sizeClasses.md,
    focused ? 'ring-2 ring-accent-500' : '',
    className,
  );
  const content = (
    <>
      {loading ? (
        <span className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
      ) : (
        icon
      )}
      {children}
    </>
  );

  if (href) {
    const anchorProps = props as AnchorHTMLAttributes<HTMLAnchorElement>;
    return (
      <a
        {...anchorProps}
        ref={ref as Ref<HTMLAnchorElement>}
        href={href}
        className={classes}
        title={tip ?? anchorProps.title}
      >
        {content}
      </a>
    );
  }

  const buttonProps = props as ButtonHTMLAttributes<HTMLButtonElement>;
  return (
    <button
      {...buttonProps}
      ref={ref as Ref<HTMLButtonElement>}
      type={type}
      className={classes}
      title={tip ?? buttonProps.title}
      disabled={disabled || loading}
    >
      {content}
    </button>
  );
});
