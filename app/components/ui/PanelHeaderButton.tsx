import { memo, type MouseEvent, type ReactNode } from 'react';
import { classNames } from '~/utils/classNames';

interface PanelHeaderButtonProps {
  className?: string;
  disabledClassName?: string;
  disabled?: boolean;
  children: ReactNode;
  onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
}

export const PanelHeaderButton = memo(function PanelHeaderButton({
  className,
  disabledClassName,
  disabled = false,
  children,
  onClick,
}: PanelHeaderButtonProps) {
  return (
    <button
      className={classNames(
        'flex items-center shrink-0 gap-1.5 px-1.5 rounded-md py-0.5 text-content-secondary bg-transparent enabled:hover:text-bolt-elements-item-contentActive enabled:hover:bg-bolt-elements-item-backgroundActive disabled:cursor-not-allowed',
        {
          [classNames('opacity-30', disabledClassName)]: disabled,
        },
        className,
      )}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
});
