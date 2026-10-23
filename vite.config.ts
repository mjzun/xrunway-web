import { iwsdkDev } from "@iwsdk/vite-plugin-dev";

import { compileUIKit } from "@iwsdk/vite-plugin-uikitml";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { defineConfig, type PluginOption } from "vite";
import { WebSocketServer, type WebSocket } from "ws";
import mkcert from "vite-plugin-mkcert";

/**
 * Opt-in HTTPS for real-device testing (Quest over LAN, phone camera). Off by
 * default so the everyday `npm run dev` (and the preview tooling) never trips
 * the mkcert CA-install sudo prompt. Enable with:  XRUNWAY_HTTPS=1 npm run dev
 * (you enter your macOS password ONCE the first time for the trusted CA).
 */
const HTTPS = process.env.XRUNWAY_HTTPS === "1";

/**
 * (X)RUNWAY pose relay — Phase 2 external tracker transport.
 *
 * A dumb broadcast relay on its own port (8082): the companion capture page
 * (/companion/, on a phone) and the headset app both connect; any message from
 * one peer is rebroadcast to the others. Runs inside `npm run dev` (vite) AND
 * `vite preview` — preview on :4174 behind cloudflared is the documented
 * on-device path (QUEST-TESTING.md), and the built app ships the full camera
 * story, so preview must ship the pipeline too (#36). For production / native
 * sources this becomes a real relay service — same protocol.
 */
const POSE_RELAY_PORT = 8082;

/** The TLS options vite resolves for `server.https` / `preview.https`. */
type RelayHttpsOpts =
  | { cert?: string | Buffer; key?: string | Buffer }
  | boolean
  | undefined;

interface RelayHost {
  logger: { info(msg: string): void; warn(msg: string): void };
  /** Match the page's transport: when vite serves HTTPS (mkcert), the page +
   * companion dial wss://, so the relay must serve TLS too — reuse mkcert's
   * cert/key. Plain ws:// on the HTTP/emulator path. (See docs/SENSORS.md.) */
  httpsOpts: RelayHttpsOpts;
  /** The vite HTTP(S) server whose close tears the relay down with it. */
  httpServer: { on(event: "close", cb: () => void): void } | null;
}

/** One relay, two hosts: configureServer (dev) and configurePreviewServer
 * (preview) both delegate here, so the two paths can never drift. A busy port
 * (e.g. dev and preview running side by side) degrades to a warning, never a
 * crash — the app itself keeps running on head-only metrics. */
function startPoseRelay({ logger, httpsOpts, httpServer }: RelayHost): void {
  let wss: WebSocketServer;
  let relayHttps: HttpsServer | undefined;
  try {
    if (
      httpsOpts &&
      typeof httpsOpts === "object" &&
      httpsOpts.cert &&
      httpsOpts.key
    ) {
      relayHttps = createHttpsServer({
        cert: httpsOpts.cert,
        key: httpsOpts.key,
      });
      // Async bind failure (EADDRINUSE) arrives as an 'error' event; without a
      // handler it would take the whole dev/preview process down.
      relayHttps.on("error", (err) =>
        logger.warn(`[pose-relay] could not bind :${POSE_RELAY_PORT} — ${String(err)}`),
      );
      relayHttps.listen(POSE_RELAY_PORT);
      wss = new WebSocketServer({ server: relayHttps });
    } else {
      wss = new WebSocketServer({ port: POSE_RELAY_PORT });
    }
  } catch (err) {
    logger.warn(
      `[pose-relay] could not bind :${POSE_RELAY_PORT} — ${String(err)}`,
    );
    return;
  }
  const clients = new Set<WebSocket>();
  wss.on("connection", (ws) => {
    clients.add(ws);
    ws.on("message", (data) => {
      const text = data.toString();
      for (const c of clients) {
        if (c !== ws && c.readyState === 1) c.send(text);
      }
    });
    ws.on("close", () => clients.delete(ws));
    ws.on("error", () => clients.delete(ws));
  });
  wss.on("error", (err) => logger.warn(`[pose-relay] ${String(err)}`));
  const relayProto = relayHttps ? "wss" : "ws";
  logger.info(
    `  \x1b[36m➜  pose relay:\x1b[0m ${relayProto}://<lan-ip>:${POSE_RELAY_PORT}`,
  );
  httpServer?.on("close", () => {
    wss.close();
    relayHttps?.close();
  });
}

function poseRelay(): PluginOption {
  return {
    name: "xrunway-pose-relay",
    apply: "serve",
    configureServer(server) {
      startPoseRelay({
        logger: server.config.logger,
        httpsOpts: server.config.server.https as RelayHttpsOpts,
        httpServer: server.httpServer,
      });
    },
    // `vite preview` resolves with command "serve", so this plugin loads there
    // too — without this hook the preview/tunnel deployment shipped the whole
    // camera UI with a dead pipeline (#36). mkcert mirrors its cert into
    // preview.https, so the XRUNWAY_HTTPS branch behaves exactly like dev;
    // the server.https fallback covers a manually-configured cert.
    configurePreviewServer(server) {
      startPoseRelay({
        logger: server.config.logger,
        httpsOpts: (server.config.preview.https ??
          server.config.server.https) as RelayHttpsOpts,
        httpServer: server.httpServer,
      });
    },
  };
}

export default defineConfig({
  plugins: [
    ...(HTTPS ? [mkcert()] : []),
    poseRelay(),
    iwsdkDev({
      emulator: {
        device: "metaQuest3",

        environment: "living_room",
        // Ship the emulator IN the production build (dist/) so the shareable
        // link's ENTER HEADSET works in a normal laptop/phone browser — the
        // same emulated Quest 3 the dev server gives. Without this, `vite
        // build` strips the emulator and immersive-ar is unsupported off a
        // real headset (2026-07-05: this is exactly what broke ENTER XR on the
        // shared site).
        injectOnBuild: true,
        // Activate the emulator on ANY host (the deployed domain), not just
        // localhost. A REAL Quest is exempted by the default
        // userAgentException (/OculusBrowser/), so on-device it uses the real
        // WebXR runtime and never the emulator.
        activation: "always",
      },
      ai: { mode: "agent" },
      verbose: true,
    }),

    compileUIKit({ sourceDir: "ui", outputDir: "public/ui", verbose: true }),
  ],
  server: { host: "0.0.0.0", port: 8081, open: true },
  // `vite preview` of the production build, reachable over a tunnel for on-device
  // (Quest / phone) testing. allowedHosts:true lets the random *.trycloudflare.com
  // host past vite 7's host check. Preview-only — the dev server is unaffected.
  preview: { host: "0.0.0.0", port: 4174, allowedHosts: true },
  build: {
    outDir: "dist",
    sourcemap: process.env.NODE_ENV !== "production",
    target: "esnext",
    rollupOptions: { input: "./index.html" },
  },
  esbuild: { target: "esnext" },
  optimizeDeps: {
    exclude: ["@babylonjs/havok"],
    esbuildOptions: { target: "esnext" },
  },
  publicDir: "public",
  base: "./",
});
