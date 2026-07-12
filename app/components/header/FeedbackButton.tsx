import { ChatBubbleIcon } from '@radix-ui/react-icons';
import { MenuItem } from '@ui/Menu';
import { Button } from '@ui/Button';
import { Modal } from '@ui/Modal';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';

const categories = [
  { value: 'idea', label: 'Idea', emoji: '✨' },
  { value: 'bug', label: 'Bug', emoji: '🪲' },
  { value: 'ux', label: 'UX', emoji: '🎨' },
  { value: 'other', label: 'Other', emoji: '💬' },
] as const;

type FeedbackCategory = (typeof categories)[number]['value'];

export function FeedbackButton({ showInMenu }: { showInMenu: boolean }) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      {showInMenu ? (
        <MenuItem action={() => setIsOpen(true)}>
          <ChatBubbleIcon className="text-content-secondary" />
          <span>Submit feedback</span>
        </MenuItem>
      ) : (
        <Button
          variant="neutral"
          size="xs"
          className="hidden sm:flex"
          onClick={() => setIsOpen(true)}
          icon={<ChatBubbleIcon />}
        >
          Submit feedback
        </Button>
      )}
      {isOpen && <FeedbackModal onClose={() => setIsOpen(false)} />}
    </>
  );
}

function FeedbackModal({ onClose }: { onClose: () => void }) {
  const [category, setCategory] = useState<FeedbackCategory>('idea');
  const [message, setMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setIsSubmitting(true);
    try {
      const response = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ category, message, pagePath: window.location.pathname }),
      });
      const body = (await response.json().catch(() => null)) as { error?: string } | null;
      if (!response.ok) {
        throw new Error(body?.error ?? 'Unable to submit feedback.');
      }
      onClose();
      toast.success('Thanks! Your feedback was saved.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Unable to submit feedback.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal
      onClose={isSubmitting ? undefined : onClose}
      title={
        <div>
          <p className="app-page-eyebrow">Help shape Ghostbuild</p>
          <h2 className="mt-1 text-xl font-black text-content-primary">What should we improve?</h2>
        </div>
      }
      description="Your feedback is saved privately and reviewed by the Ghostbuild team."
    >
      <form onSubmit={submit} className="space-y-4">
        <fieldset>
          <legend className="mb-2 text-xs font-bold tracking-wide text-content-tertiary uppercase">Category</legend>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {categories.map((option) => (
              <label
                key={option.value}
                className="flex cursor-pointer items-center justify-center gap-1.5 rounded-xl border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-3 py-2 text-sm font-bold has-[:checked]:border-accent-500 has-[:checked]:bg-bolt-elements-item-backgroundAccent"
              >
                <input
                  type="radio"
                  name="feedback-category"
                  value={option.value}
                  checked={category === option.value}
                  onChange={() => setCategory(option.value)}
                  className="sr-only"
                />
                <span aria-hidden>{option.emoji}</span>
                {option.label}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="block">
          <span className="mb-2 block text-xs font-bold tracking-wide text-content-tertiary uppercase">Feedback</span>
          <textarea
            autoFocus
            required
            minLength={3}
            maxLength={4000}
            rows={6}
            value={message}
            onChange={(event) => setMessage(event.currentTarget.value)}
            placeholder="Tell us what happened, what you expected, or what would make Ghostbuild better…"
            className="w-full resize-y rounded-2xl border border-bolt-elements-borderColor bg-bolt-elements-background-depth-2 px-4 py-3 text-sm text-content-primary outline-none transition-shadow placeholder:text-content-tertiary focus:border-accent-500 focus:shadow-[0_0_0_3px_color-mix(in_srgb,var(--ghost-home-accent)_12%,transparent)]"
          />
          <span className="mt-1 block text-right text-xs text-content-tertiary">{message.length}/4000</span>
        </label>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="neutral" onClick={onClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button type="submit" loading={isSubmitting} disabled={message.trim().length < 3}>
            Send feedback
          </Button>
        </div>
      </form>
    </Modal>
  );
}
