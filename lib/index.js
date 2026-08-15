/**
 * dsh-lan-bridge — Cordis plugin (host plane).
 *
 * Mounts a LAN-facing reverse proxy that fronts this profile's own web server
 * (Host/Origin rewritten to the loopback face), so devices on the trusted LAN
 * can use the full /api surface — including the loopback-pinned privileged
 * methods (settings, credentials, agent presets, native dialogs).
 *
 * Lifecycle: starts when the profile loads, stops (server closed) when the
 * profile disposes — no external service, no startup folder, nothing to run
 * manually. Configuration lives in the profile's cordis.patch.yml row.
 *
 * SECURITY: this bridge is NOT authentication. Anyone who can reach
 * listenHost:listenPort gains full agent and configuration-plane control.
 * Keep it on a trusted LAN only; do not port-forward it to the internet.
 *
 * @module dsh-lan-bridge
 */
import Schema from "@deepseek-ai/schemastery";
import { createLanProxy } from "./proxy.js";

export const name = "lan-bridge";
export const inject = [];

export const Config = Schema.object({
  enabled: Schema.boolean().default(true),
  listenHost: Schema.string().default("0.0.0.0"),
  listenPort: Schema.number().default(2882),
  targetHost: Schema.string().default("127.0.0.1"),
  targetPort: Schema.number().default(2881),
});

export function apply(ctx, config = {}) {
  if (config.enabled === false) return;

  // Prefer the active web server's port as the upstream target when the
  // service exists (web profile), so the bridge always follows the GUI port.
  let targetPort = config.targetPort ?? 2881;
  try {
    const webServer = ctx?.get?.("webServer");
    if (webServer?.port !== undefined) targetPort = webServer.port;
  } catch {
    /* webServer service absent on this surface — keep configured default */
  }

  let bridge;
  try {
    bridge = createLanProxy({
      listenHost: config.listenHost ?? "0.0.0.0",
      listenPort: config.listenPort ?? 2882,
      targetHost: config.targetHost ?? "127.0.0.1",
      targetPort,
    });
  } catch (error) {
    ctx.logger?.("lan-bridge").error?.(`lan-bridge: failed to create proxy: ${String(error)}`);
    return;
  }

  bridge.listen().then(() => {
    ctx.logger?.("lan-bridge").info?.(
      `lan-bridge: listening on ${config.listenHost ?? "0.0.0.0"}:${config.listenPort ?? 2882} -> http://${config.targetHost ?? "127.0.0.1"}:${targetPort} (Host/Origin rewritten to the loopback face)`
    );
  }).catch((error) => {
    // Never fail the profile boot: log and continue (port busy, etc.).
    ctx.logger?.("lan-bridge").error?.(`lan-bridge: failed to listen: ${String(error)}`);
  });

  ctx.effect(() => () => {
    try {
      void bridge.close();
    } catch {
      /* already closed */
    }
  }, "dsh-lan-bridge: proxy lifecycle");
}
