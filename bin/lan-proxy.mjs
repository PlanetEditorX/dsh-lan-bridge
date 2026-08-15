#!/usr/bin/env node
/**
 * Standalone runner for the dsh-lan-bridge proxy (no dsh profile needed).
 *
 *   node bin/lan-proxy.mjs [--host 0.0.0.0] [--port 2882]
 *                         [--target-host 127.0.0.1] [--target-port 2881]
 *
 * Useful for testing or for running the bridge outside the harness.
 */
import { createLanProxy } from "../lib/proxy.js";

const args = process.argv.slice(2);
function value(name, fallback) {
  const index = args.indexOf(name);
  return index !== -1 && args[index + 1] !== undefined ? args[index + 1] : fallback;
}
const listenHost = value("--host", "0.0.0.0");
const listenPort = Number(value("--port", "2882"));
const targetHost = value("--target-host", "127.0.0.1");
const targetPort = Number(value("--target-port", "2881"));

const bridge = createLanProxy({ listenHost, listenPort, targetHost, targetPort });
bridge.listen().then(() => {
  console.log(`lan-bridge: listening on http://${listenHost}:${listenPort} -> http://${targetHost}:${targetPort} (Host/Origin rewritten)`);
}).catch((error) => {
  console.error(`lan-bridge: failed to listen: ${error.message}`);
  process.exit(1);
});

function shutdown() {
  void bridge.close().finally(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
