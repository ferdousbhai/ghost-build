import { useEffect, useState } from 'react';
import { Button } from '@ui/Button';
import { productTelemetryEnabled, setProductTelemetryEnabled } from '~/lib/telemetry.client';

export function TelemetryPreference() {
  const [ready, setReady] = useState(false);
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    setEnabled(productTelemetryEnabled());
    setReady(true);
  }, []);

  const updatePreference = (next: boolean) => {
    setProductTelemetryEnabled(next);
    setEnabled(productTelemetryEnabled());
  };

  return (
    <div className="app-card mt-4 p-4" aria-live="polite">
      <p className="mt-0 font-medium text-content-primary">
        Product telemetry is {ready && enabled ? 'enabled' : 'disabled'} on this browser.
      </p>
      <p>
        This choice is stored on this device. Global Privacy Control and Do Not Track keep telemetry disabled even if
        you opt in.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" disabled={!ready || enabled} onClick={() => updatePreference(true)}>
          Allow telemetry
        </Button>
        <Button size="sm" variant="neutral" disabled={!ready || !enabled} onClick={() => updatePreference(false)}>
          Disable telemetry
        </Button>
      </div>
    </div>
  );
}
