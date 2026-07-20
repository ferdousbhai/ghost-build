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
      tip="Enhance your prompt"
      aria-label={isEnhancing ? 'Enhancing prompt' : 'Enhance prompt'}
      aria-busy={isEnhancing}
      disabled={disabled || isEnhancing}
      inline
      onClick={onClick}
    >
      <div className="text-lg">
        {!isEnhancing ? <SparklesIcon className="size-4" /> : <Spinner className="size-4" />}
      </div>
    </Button>
  );
});
