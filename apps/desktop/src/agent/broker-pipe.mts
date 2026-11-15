import net from "node:net";
import { agentDesktopError } from "./contracts.mjs";
import { isValidBrokerEndpointPath } from "./ipc-transport.mjs";
import { maximumMessageLength } from "./secure-pipe-relay.mjs";

/** The ceiling for a single local pipe exchange. */
export const brokerPipeTimeoutMs = 30_000;

/**
 * Sends one newline-terminated frame over the local named pipe and resolves
 * with the first reply line. The Broker host, its clients and the unpaired
 * liveness probe all speak through here, so the transport limits have one
 * owner. Moved out of desktop-broker.mts to keep that file under its
 * max-lines ratchet.
 */
export async function requestPipe(pathname: string, request: string, timeoutMs = brokerPipeTimeoutMs): Promise<string> {
  if (
    !isValidBrokerEndpointPath(pathname)
    || request.length > maximumMessageLength
    || !Number.isInteger(timeoutMs)
    || timeoutMs < 100
    || timeoutMs > brokerPipeTimeoutMs
  ) {
    throw agentDesktopError("BROKER_SECURITY_UNAVAILABLE", "The NamiMail Agent pipe endpoint is invalid.");
  }
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let received = "";
    const socket = net.createConnection(pathname);
    const finishFailure = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.removeAllListeners();
      socket.destroy();
      callback();
    };
    const finishSuccess = (line: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.removeAllListeners();
      let closeTimeout: NodeJS.Timeout | undefined;
      const complete = () => {
        if (!closeTimeout) return;
        clearTimeout(closeTimeout);
        closeTimeout = undefined;
        socket.destroy();
        resolve(line);
      };
      socket.once("close", complete);
      socket.once("error", complete);
      closeTimeout = setTimeout(complete, 250);
      closeTimeout.unref?.();
      try {
        // Electron's named-pipe client can leave a relay instance occupied
        // after an abrupt destroy. Complete the response exchange first so
        // PowerShell can recreate its single-instance SID-DACL pipe.
        socket.end();
      } catch {
        complete();
      }
    };
    const timeout = setTimeout(() => finishFailure(() => reject(agentDesktopError(
      "HOST_UNAVAILABLE",
      "NamiMail Agent host did not respond in time.",
      true,
      "Open Nami Mail and try again.",
    ))), timeoutMs);
    timeout.unref?.();
    socket.once("connect", () => {
      socket.write(`${request}\n`);
    });
    socket.on("data", (chunk: Buffer) => {
      received += chunk.toString("utf8");
      if (received.length > maximumMessageLength) {
        finishFailure(() => reject(agentDesktopError("BROKER_AUTHENTICATION_FAILED", "The NamiMail Agent response is too large.")));
        return;
      }
      const lineEnd = received.indexOf("\n");
      if (lineEnd === -1) return;
      const line = received.slice(0, lineEnd).replace(/\r$/, "");
      finishSuccess(line);
    });
    socket.once("error", () => finishFailure(() => reject(agentDesktopError(
      "HOST_UNAVAILABLE",
      "NamiMail Agent host is not available.",
      true,
      "Open Nami Mail or run namimail service start.",
    ))));
    socket.once("end", () => {
      if (!settled) finishFailure(() => reject(agentDesktopError("HOST_UNAVAILABLE", "NamiMail Agent host closed the local pipe.", true)));
    });
  });
}
