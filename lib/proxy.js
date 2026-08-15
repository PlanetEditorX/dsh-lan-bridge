/**
 * dsh-lan-bridge — reverse-proxy core.
 *
 * Forwards every request (HTTP and WebSocket upgrades) from a LAN-facing
 * listener to the DeepSeek Harness web server on 127.0.0.1, rewriting the
 * `Host` and `Origin` headers to the loopback authority.
 *
 * WHY: the harness /api trust fence (`dsh-client-connection`) accepts any
 * request whose Host is a loopback hostname (or a configured trusted LAN
 * literal) and whose Origin — when present — matches that Host. Privileged
 * methods (`settings.*`, `credentials.*`, `agentPreset.*`, `host.pickDirectory`,
 * `host.openPath`, `llm.discoverModels`) are additionally pinned to loopback.
 * The fence only reads headers, so a same-machine proxy that presents the
 * loopback face makes the whole surface reachable from the trusted LAN
 * through THIS listener and nowhere else.
 *
 * SECURITY: this is NOT authentication. Anyone who can reach the listen
 * address gets full agent + configuration-plane control. Bind it only on a
 * trusted LAN, keep it behind a private-profile firewall rule, and do NOT
 * port-forward it to the internet.
 *
 * Robustness contract: this module may run inside the harness host process,
 * so it must never throw into an unhandled 'error' event. Every socket it
 * touches gets an error sink, and every handler body is wrapped.
 */
import http from "node:http";

/** Default HTML injection: polyfill crypto.randomUUID for non-secure-context
 * (http://<LAN-IP>) clients. The harness frontend calls crypto.randomUUID for
 * every RPC id (dsh-client-connection/lib/client.js), and it is undefined
 * outside secure contexts — without this, all /api calls fail from a phone.
 * getRandomValues is available everywhere. */
const DEFAULT_HTML_INJECT = `<script>if(typeof crypto.randomUUID!=="function"){crypto.randomUUID=function(){var b=crypto.getRandomValues(new Uint8Array(16));b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;var h=Array.prototype.map.call(b,function(x){return("0"+x.toString(16)).slice(-2)}).join("");return h.slice(0,8)+"-"+h.slice(8,12)+"-"+h.slice(12,16)+"-"+h.slice(16,20)+"-"+h.slice(20)}};</script>`;

/**
 * Create the LAN-facing proxy server.
 * @param {object} [options]
 * @param {string} [options.listenHost='0.0.0.0'] - bind address for the LAN face.
 * @param {number} [options.listenPort=2882] - bind port for the LAN face.
 * @param {string} [options.targetHost='127.0.0.1'] - upstream harness host.
 * @param {number} [options.targetPort=2881] - upstream harness web port.
 * @param {string|boolean} [options.htmlInject] - HTML fragment injected before
 *   `</head>` in text/html responses (default: crypto.randomUUID polyfill;
 *   `false` disables injection; a custom string replaces the polyfill).
 * @param {object} [options.log] - console-like logger.
 * @returns {{ server: import('node:http').Server, listen(): Promise<void>, close(): Promise<void>, target: {host: string, port: number} }}
 */
export function createLanProxy(options = {}) {
  const listenHost = options.listenHost ?? "0.0.0.0";
  const listenPort = options.listenPort ?? 2882;
  const targetHost = options.targetHost ?? "127.0.0.1";
  const targetPort = options.targetPort ?? 2881;
  const targetAuthority = `${targetHost}:${targetPort}`;
  const targetOrigin = `http://${targetAuthority}`;
  const htmlInject = options.htmlInject === undefined ? DEFAULT_HTML_INJECT : options.htmlInject;
  const log = options.log ?? console;

  /** Copy request headers with Host/Origin rewritten to the loopback face. */
  function rewrite(headers) {
    const out = { ...headers };
    out.host = targetAuthority;
    if (out.origin !== undefined) out.origin = targetOrigin;
    return out;
  }

  /** Rebuild the upstream 101 response head (headers were consumed by the parser). */
  function upgradeResponseHead(upstreamRes) {
    const raw = upstreamRes.rawHeaders ?? [];
    const lines = [];
    for (let i = 0; i < raw.length; i += 2) lines.push(`${raw[i]}: ${raw[i + 1]}`);
    return `HTTP/1.1 101 Switching Protocols\r\n${lines.join("\r\n")}\r\n\r\n`;
  }

  const server = http.createServer((req, res) => {
    const upstream = http.request({
      host: targetHost,
      port: targetPort,
      method: req.method,
      path: req.url,
      headers: rewrite(req.headers),
    }, (upstreamRes) => {
      const contentType = upstreamRes.headers["content-type"];
      const isHtml = typeof contentType === "string" && contentType.toLowerCase().startsWith("text/html");
      const canInject = htmlInject !== false && isHtml && upstreamRes.headers["content-encoding"] === undefined;
      if (!canInject) {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
        upstreamRes.on("error", () => res.destroy());
        return;
      }
      // Buffer the (small) HTML document, inject the fragment before </head>,
      // and resend with a corrected content-length.
      const chunks = [];
      upstreamRes.on("data", (chunk) => chunks.push(chunk));
      upstreamRes.on("error", () => res.destroy());
      upstreamRes.on("end", () => {
        try {
          let body = Buffer.concat(chunks).toString("utf8");
          const marker = "</head>";
          const index = body.lastIndexOf(marker);
          body = index === -1 ? body + String(htmlInject) : body.slice(0, index) + String(htmlInject) + body.slice(index);
          const output = Buffer.from(body, "utf8");
          const headers = { ...upstreamRes.headers };
          delete headers["content-encoding"];
          delete headers["transfer-encoding"];
          headers["content-length"] = String(output.length);
          res.writeHead(upstreamRes.statusCode ?? 200, headers);
          res.end(output);
        } catch {
          res.destroy();
        }
      });
    });
    upstream.on("error", (error) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      try {
        res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
        res.end(`lan-bridge: upstream ${targetAuthority} unavailable: ${error.message}`);
      } catch {
        res.destroy();
      }
    });
    req.on("error", () => upstream.destroy());
    res.on("close", () => {
      if (!res.writableEnded) {
        upstream.destroy();
        req.destroy();
      }
    });
    req.pipe(upstream);
  });

  // WebSocket upgrades: the GUI's /api/events.mux and /api/events.host streams.
  server.on("upgrade", (req, socket, head) => {
    const clientHead = head;
    const clientSocket = socket;
    clientSocket.on("error", () => {
      /* peer gone; pipes end on their own */
    });
    const upstream = http.request({
      host: targetHost,
      port: targetPort,
      method: req.method ?? "GET",
      path: req.url,
      headers: rewrite(req.headers),
    });
    upstream.on("error", (error) => {
      try {
        clientSocket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      } catch {
        /* client already gone */
      }
      clientSocket.destroy();
      log.warn?.(`lan-bridge: upstream upgrade failed: ${error.message}`);
    });
    // Upstream declined the upgrade (e.g. the fence's 403): relay the plain
    // response so the client never hangs.
    upstream.on("response", (upstreamRes) => {
      try {
        const raw = upstreamRes.rawHeaders ?? [];
        const lines = [];
        for (let i = 0; i < raw.length; i += 2) lines.push(`${raw[i]}: ${raw[i + 1]}`);
        clientSocket.write(
          `HTTP/1.1 ${upstreamRes.statusCode ?? 502} ${upstreamRes.statusMessage ?? ""}\r\n${lines.join("\r\n")}\r\n\r\n`
        );
        upstreamRes.pipe(clientSocket);
        upstreamRes.on("error", () => clientSocket.destroy());
      } catch {
        clientSocket.destroy();
      }
    });
    upstream.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
      upstreamSocket.on("error", () => clientSocket.destroy());
      try {
        // Downstream: 101 head, then any bytes the harness sent after it.
        clientSocket.write(upgradeResponseHead(upstreamRes));
        if (upstreamHead && upstreamHead.length) upstreamSocket.write(upstreamHead);
        // Upstream: any bytes the client sent after its request head.
        if (clientHead && clientHead.length) upstreamSocket.write(clientHead);
      } catch {
        clientSocket.destroy();
        upstreamSocket.destroy();
        return;
      }
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
    });
    upstream.end();
  });

  server.on("error", (error) => {
    log.error?.(`lan-bridge: server error: ${error.message}`);
  });

  return {
    server,
    target: { host: targetHost, port: targetPort },
    listen: () => new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(listenPort, listenHost, () => {
        server.off("error", reject);
        resolve();
      });
    }),
    close: () => new Promise((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
      server.closeAllConnections?.();
      server.closeIdleConnections?.();
    }),
  };
}
