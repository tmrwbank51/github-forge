// Boot wiring for the forge: bind a port, announce it to the suite,
// serve until the suite reports it is done, then exit.
//
// The suite (the trial harness) runs in the same pod and is the only
// client. The handshake it expects is:
//
//   1. Listen on an ephemeral port, on every interface.
//   2. POST {"port": <port>} to $MAKEFUN_ENV_URL/register.
//   3. Poll GET $MAKEFUN_ENV_URL/done until it answers {"done": true}.
//   4. Shut the server down and exit with status 0.
//
// All request handling lives in app.ts; this file only performs the
// handshake above and waits. It uses no clock readings and no randomness
// in anything it sends (a sleeping wait is not a timestamp), makes no
// model calls, and holds no keys.

import type { Server } from "node:http";

import { createApp } from "./app.ts";

// Gap between one /done probe and the next.
const PROBE_GAP_MS = 1000;
// Gap between one /register attempt and the next, and how many attempts
// to make before giving up on the handshake entirely.
const ANNOUNCE_GAP_MS = 500;
const ANNOUNCE_ATTEMPTS = 12;
// How long a signal-driven shutdown waits for the server to close
// before exiting regardless.
const SHUTDOWN_GRACE_MS = 1000;

function wait(milliseconds: number): Promise<void> {
  return new Promise((resume) => setTimeout(resume, milliseconds));
}

function suiteBaseUrl(): string {
  const configured = process.env.MAKEFUN_ENV_URL ?? "";
  return configured.replace(/\/+$/, "");
}

async function listenEphemeral(server: Server): Promise<number> {
  await new Promise<void>((started, failed) => {
    server.once("error", failed);
    server.listen(0, "0.0.0.0", () => {
      server.removeListener("error", failed);
      started();
    });
  });
  const bound = server.address();
  if (bound === null || typeof bound === "string") {
    throw new Error("forge server bound without a numeric port");
  }
  return bound.port;
}

async function announceToSuite(baseUrl: string, port: number): Promise<void> {
  let latestFailure: unknown = null;
  for (let attempt = 1; attempt <= ANNOUNCE_ATTEMPTS; attempt += 1) {
    try {
      const reply = await fetch(`${baseUrl}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ port }),
      });
      await reply.text();
      if (reply.ok) {
        return;
      }
      latestFailure = new Error(`suite register answered HTTP ${reply.status}`);
    } catch (failure) {
      latestFailure = failure;
    }
    if (attempt < ANNOUNCE_ATTEMPTS) {
      await wait(ANNOUNCE_GAP_MS);
    }
  }
  if (latestFailure instanceof Error) {
    throw latestFailure;
  }
  throw new Error("suite register failed");
}

async function awaitSuiteDone(baseUrl: string): Promise<void> {
  for (;;) {
    try {
      const reply = await fetch(`${baseUrl}/done`);
      const payload: unknown = await reply.json();
      const finished =
        typeof payload === "object" &&
        payload !== null &&
        (payload as { done?: unknown }).done === true;
      if (finished) {
        return;
      }
    } catch (failure) {
      const detail = failure instanceof Error ? failure.message : String(failure);
      console.error(`done probe failed, will retry: ${detail}`);
    }
    await wait(PROBE_GAP_MS);
  }
}

async function boot(): Promise<void> {
  const server = createApp();
  const baseUrl = suiteBaseUrl();

  // A server-level fault in the middle of a trial must not take the
  // forge down: report it and keep serving. A fault while binding is
  // still fatal, through listenEphemeral above.
  server.on("error", (fault: Error) => {
    console.error(`forge server error: ${fault.message}`);
  });

  const stopOnSignal = (): void => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
  };
  process.once("SIGINT", stopOnSignal);
  process.once("SIGTERM", stopOnSignal);

  const port = await listenEphemeral(server);
  console.log(`forge listening on port ${port}`);

  if (baseUrl === "") {
    // No suite attached: a manual run. Serve until the process is
    // stopped from the outside.
    console.log("MAKEFUN_ENV_URL is unset; serving without a suite");
    return;
  }

  await announceToSuite(baseUrl, port);
  console.log(`forge announced port ${port} to the suite`);
  await awaitSuiteDone(baseUrl);
  console.log("suite reported done; shutting down");
  server.close();
  process.exit(0);
}

boot().catch((failure: unknown) => {
  const detail = failure instanceof Error ? failure.message : String(failure);
  console.error(`forge failed to start: ${detail}`);
  process.exit(1);
});
