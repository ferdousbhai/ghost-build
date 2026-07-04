import type { ReactNode } from 'react';
import { classNames } from '~/utils/classNames';

type OptionValue = string | number;
type Option<Value extends OptionValue = OptionValue> = { label: string; value: Value };

type ComboboxProps<Value extends OptionValue> = {
  label: string;
  labelHidden?: boolean;
  options: Option<Value>[];
  selectedOption?: Value | null;
  setSelectedOption: (value: Value | null) => void;
  className?: string;
  buttonClasses?: string;
  disabled?: boolean;
  placeholder?: string;
  Option?: (props: Option<Value> & { inButton?: boolean }) => ReactNode;
};

export function Combobox<Value extends OptionValue>({
  label,
  labelHidden,
  options,
  selectedOption,
  setSelectedOption,
  className,
  buttonClasses,
  disabled,
  placeholder = 'Select...',
  Option: optionRenderer,
}: ComboboxProps<Value>) {
  const selected = options.find((option) => option.value === selectedOption);
  return (
    <label className={classNames('inline-flex flex-col gap-1 text-sm', className)}>
      {!labelHidden && <span className="text-content-secondary text-xs">{label}</span>}
      <select
        className={classNames(
          'min-h-8 rounded-md border border-bolt-elements-borderColor bg-bolt-elements-background-depth-1 px-2 py-1 text-content-primary',
          buttonClasses,
        )}
        aria-label={label}
        disabled={disabled}
        value={selectedOption ?? ''}
        onChange={(event) => {
          const value = event.currentTarget.value;
          const option = options.find((option) => String(option.value) === value);
          setSelectedOption(option?.value ?? null);
        }}
      >
        <option value="">
          {selected && optionRenderer ? optionRenderer({ ...selected, inButton: true }) : placeholder}
        </option>
        {options.map((option) => (
          <option key={String(option.value)} value={String(option.value)}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
