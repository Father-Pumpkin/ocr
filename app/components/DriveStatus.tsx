import { useEffect, useState, useCallback } from 'react';
import { api, type DriveStatus as DriveStatusT } from '../lib/api';
import { Button } from './ui';

/**
 * Banner showing Google Drive connection state. Hidden when connected — or in
 * the hosted app, where Drive is set via env and can't be connected from the
 * browser (status.connectable === false). Offers a Connect button locally.
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

  // Hide until known, once connected, or where Drive can't be browser-connected.
  if (!status || status.connected || status.connectable === false) return null;

  const connecting = status.connecting || starting;

  return (
    <div className="mb-5 flex items-center justify-between gap-4 rounded-lg border border-warn/30 bg-warn-soft px-4 py-3 text-sm text-warn">
      <div>
        {connecting ? (
          <span>Connecting to Google Drive — complete the login in the browser window that opened…</span>
        ) : (
          <span>
            Google Drive isn’t connected. Page images and library sync are unavailable until you reconnect.
            {status.reason && <span className="ml-1 opacity-80">({status.reason})</span>}
          </span>
        )}
      </div>
      {!connecting && (
        <Button variant="primary" size="sm" onClick={onConnect} className="shrink-0">
          Connect Drive
        </Button>
      )}
    </div>
  );
}
