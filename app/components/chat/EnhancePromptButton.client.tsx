import { Button } from '@ui/Button';
import React from 'react';
import { Spinner } from '@ui/Spinner';
import { SparklesIcon } from '@heroicons/react/24/outline';

interface EnhancePromptButtonProps {
  isEnhancing?: boolean;
  disabled?: boolean;
  onClick: (event: React.MouseEvent<HTMLButtonElement, MouseEvent>) => void;
}

export const EnhancePromptButton = React.memo(function EnhancePromptButton({
  isEnhancing,
  disabled,
  onClick,
}: EnhancePromptButtonProps) {
  return (
    <Button
      variant="neutral"
      tip="Refine your build plan"
      aria-label={isEnhancing ? 'Refining build plan' : 'Refine build plan'}
      aria-busy={isEnhancing}
      disabled={disabled || isEnhancing}
      inline
      size="xs"
      className="h-8 min-w-8 px-2"
      onClick={onClick}
    >
      <div className="text-lg">
        {!isEnhancing ? <SparklesIcon className="size-4" /> : <Spinner className="size-4" />}
      </div>
    </Button>
  );
});
