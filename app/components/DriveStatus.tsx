import { useEffect, useState, useCallback } from 'react';
import { api, type DriveStatus as DriveStatusT } from '../lib/api';

/**
 * Banner showing Google Drive connection state. Hidden when connected. Offers a
 * Connect button that kicks off the browser OAuth flow, then polls until done.
 */
export function DriveStatus({ onConnected }: { onConnected?: () => void }) {
  const [status, setStatus] = useState<DriveStatusT | null>(null);
  const [starting, setStarting] = useState(false);

  const refresh = useCallback(async () => {
    const s = await api.getDriveStatus().catch(() => null);
    if (s) setStatus(s);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Poll while a connect is in flight
  useEffect(() => {
    if (!status?.connecting) return;
    const id = setInterval(async () => {
      const s = await api.getDriveStatus().catch(() => null);
      if (!s) return;
      setStatus(s);
      if (s.connected) onConnected?.();
    }, 2000);
    return () => clearInterval(id);
  }, [status?.connecting, onConnected]);

  async function onConnect() {
    setStarting(true);
    try {
      await api.connectDrive();
      await refresh();
    } finally {
      setStarting(false);
    }
  }

  // Don't render until we know, and hide entirely once connected
  if (!status || status.connected) return null;

  const connecting = status.connecting || starting;

  return (
    <div className="mb-4 flex items-center justify-between gap-4 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm">
      <div className="text-amber-800">
        {connecting ? (
          <span>Connecting to Google Drive — complete the login in the browser window that opened…</span>
        ) : (
          <span>
            Google Drive isn’t connected. Page images and library sync are unavailable until you reconnect.
            {status.reason && <span className="ml-1 text-amber-600">({status.reason})</span>}
          </span>
        )}
      </div>
      {!connecting && (
        <button
          onClick={onConnect}
          className="shrink-0 rounded-md bg-amber-600 px-3 py-1.5 font-medium text-white hover:bg-amber-700"
        >
          Connect Drive
        </button>
      )}
    </div>
  );
}
