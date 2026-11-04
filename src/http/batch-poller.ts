/**
 * Polls in-flight batches, but only while there are any.
 *
 * A timer that ran forever would keep the database awake: Neon suspends a
 * compute after five idle minutes, so a query every five minutes means it never
 * sleeps and is billed around the clock, even with nothing to check. So the
 * loop stops as soon as a check finds nothing in flight, and something has to
 * start it again:
 *
 *   wake()   a batch was just submitted here, so check now.
 *   nudge()  someone is using the site, so the database is awake anyway. Catches
 *            batches this process can't see being submitted, such as an MCP
 *            session's. Cheap to call on every request.
 */
export interface BatchPoller {
  wake(): void;
  nudge(): void;
}

/**
 * @param check processes what's ready and returns how many batches are still in
 *   flight. It should count a batch it couldn't check, so a passing failure
 *   doesn't strand it until the next visitor.
 */
export function createBatchPoller(check: () => Promise<number>, intervalMs: number): BatchPoller {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let checking = false;
  // A batch submitted mid-check may be too late for that check to see.
  let recheck = false;
  let lastCheck = Number.NEGATIVE_INFINITY;

  const run = async (): Promise<void> => {
    timer = null;
    checking = true;
    recheck = false;
    lastCheck = Date.now();
    let inFlight = 1;
    try {
      inFlight = await check();
    } catch (err) {
      process.stderr.write(`[OCR HTTP] Batch poll failed: ${err}\n`);
    }
    checking = false;
    if (inFlight > 0 || recheck) {
      timer = setTimeout(() => void run(), intervalMs);
      // unref so a pending timer never keeps the process alive on shutdown.
      timer.unref?.();
    }
  };

  return {
    wake() {
      if (checking) recheck = true;
      else if (!timer) void run();
    },
    nudge() {
      if (checking || timer) return;
      if (Date.now() - lastCheck >= intervalMs) void run();
    },
  };
}
