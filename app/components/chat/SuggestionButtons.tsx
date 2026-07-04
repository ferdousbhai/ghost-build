import { Button } from '@ui/Button';
import { ArrowUpIcon } from '@radix-ui/react-icons';
import { SUGGESTIONS } from 'ghostbuild-agent/constants';

interface SuggestionButtonsProps {
  chatStarted: boolean;
  onSuggestionClick?: (suggestion: string) => void;
  disabled?: boolean;
}

export const SuggestionButtons = ({ chatStarted, onSuggestionClick, disabled }: SuggestionButtonsProps) => {
  if (chatStarted) {
    return null;
  }

  return (
    <div id="suggestions" className="mt-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-content-primary text-sm font-semibold">Blueprints</p>
        <p className="text-content-tertiary text-xs">Starter briefs</p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {SUGGESTIONS.map((suggestion) => (
          <Button
            key={suggestion.title}
            onClick={() => onSuggestionClick?.(suggestion.prompt)}
            className="h-11 justify-start rounded-md px-3 text-left shadow-sm"
            variant="neutral"
            disabled={disabled}
            icon={<ArrowUpIcon className="size-4" />}
          >
            {suggestion.title}
          </Button>
        ))}
      </div>
    </div>
  );
};
