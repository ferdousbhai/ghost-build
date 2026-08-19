import { memo, forwardRef, type ButtonHTMLAttributes, type ForwardedRef, type MouseEvent, type ReactNode } from 'react';
import { classNames } from '~/utils/classNames';

type IconSize = 'sm' | 'md' | 'lg' | 'xl' | 'xxl';

type BaseIconButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'children' | 'className' | 'disabled' | 'onClick' | 'title' | 'type'
> & {
  size?: IconSize;
  className?: string;
  iconClassName?: string;
  disabledClassName?: string;
  title: string;
  disabled?: boolean;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
};

type IconButtonWithoutChildrenProps = {
  icon: string | React.ReactNode;
  children?: undefined;
} & BaseIconButtonProps;

type IconButtonWithChildrenProps = {
  icon?: undefined;
  children: ReactNode;
} & BaseIconButtonProps;

type IconButtonProps = IconButtonWithoutChildrenProps | IconButtonWithChildrenProps;

const iconSizeClass = {
  sm: 'text-sm',
  md: 'text-md',
  lg: 'text-lg',
  xl: 'text-xl',
  xxl: 'text-2xl',
} satisfies Record<IconSize, string>;

export const IconButton = memo(
  forwardRef(
    (
      {
        icon,
        size = 'xl',
        className,
        iconClassName,
        disabledClassName,
        disabled = false,
        title,
        'aria-label': ariaLabel,
        onClick,
        children,
        ...buttonProps
      }: IconButtonProps,
      ref: ForwardedRef<HTMLButtonElement>,
    ) => {
      return (
        <button
          {...buttonProps}
          ref={ref}
          className={classNames(
            'gb-icon-button flex items-center text-content-primary bg-transparent enabled:hover:text-bolt-elements-item-contentActive rounded-md p-1 enabled:hover:bg-bolt-elements-item-backgroundActive disabled:cursor-not-allowed',
            {
              [classNames('opacity-30', disabledClassName)]: disabled,
            },
            className,
          )}
          type="button"
          aria-label={ariaLabel ?? title}
          title={title}
          disabled={disabled}
          onClick={onClick}
        >
          {children ? (
            children
          ) : typeof icon === 'string' ? (
            <div className={classNames(icon, iconSizeClass[size], iconClassName)}></div>
          ) : (
            icon
          )}
        </button>
      );
    },
  ),
);
