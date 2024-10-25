import { once } from "node:events";
import { Readable } from "node:stream";
import path from "path";
import {
  Response as MiniflareResponse,
  Request as MiniflareRequest,
  RequestInit,
  Miniflare,
} from "miniflare";
import { Connect, Plugin as VitePlugin } from "vite";
import { createMiniflare } from "./miniflare.js";
import { getPackageValue } from "./utils.js";
import type { ServerResponse } from "node:http";

const isWindows = process.platform === "win32";

const globals = globalThis as typeof globalThis & {
  __noExternalModules: Set<string>;
  __runner?: Miniflare;
};

if (!globals.__noExternalModules)
  globals.__noExternalModules = new Set<string>();

export type DevServerOptions = {
  autoNoExternal?: boolean;
  entry?: string;
  bundle?: boolean;
  injectClientScript?: boolean;
  reload?: boolean;
};

export function devServer(params?: DevServerOptions): VitePlugin {
  const {
    autoNoExternal,
    entry = "src/index.ts",
    bundle = false,
    injectClientScript = true,
    reload = false,
  } = params || {};
  let dependentFiles = new Set<string>();
  const plugin: VitePlugin = {
    name: "edge-dev-server",
    apply: "serve",
    configureServer: async (viteDevServer) => {
      if (!viteDevServer.config.server.preTransformRequests) return undefined;
      const runner =
        globals.__runner ??
        (await createMiniflare({
          viteDevServer,
          bundle,
          onDependent: (files) => {
            dependentFiles = new Set(files);
          },
        }));
      globals.__runner = runner;
      process.on("exit", () => {
        runner.dispose();
      });
      viteDevServer.watcher.on("change", (file) => {
        if (file === path.resolve(import.meta.dirname, "miniflare_module.ts")) {
          runner.dispose();
          globals.__runner = undefined;
          viteDevServer.restart();
        }
        if (reload && dependentFiles.has(file)) {
          console.info(`Updated: ${file}`);
          viteDevServer.ws.send({
            type: "full-reload",
          });
        }
      });
      return () => {
        viteDevServer.middlewares.use(async (req, res, next) => {
          try {
            const request = toRequest(req);
            request.headers.set("x-vite-entry", entry);
            let response: MiniflareResponse;
            while (true) {
              response = await runner.dispatchFetch(request.clone());
              const requestBundle = response.headers.get("x-request-bundle");
              if (!requestBundle) break;
              let normalPath = requestBundle;
              if (normalPath.startsWith("file://")) {
                normalPath = normalPath.substring(7);
              }
              if (isWindows && normalPath[0] === "/") {
                normalPath = normalPath.substring(1);
              }
              const packageName = getPackageValue(normalPath, "name");
              if (!packageName) {
                throw new Error(`'${normalPath}' Not found`);
              }
              if (!autoNoExternal) {
                throw new Error(`Add '${packageName}' to noExternal`);
              }
              globals.__noExternalModules.add(packageName);
              console.info(`Add module ${packageName}`);
              console.info(Array.from(globals.__noExternalModules));
              res.statusCode = 200;
              res.end(
                await viteDevServer.transformIndexHtml(
                  "/",
                  "<html><body>Loading</body></html>"
                )
              );
              await viteDevServer.restart();
            }
            if (!res.closed) {
              if (
                injectClientScript &&
                response.headers.get("content-type")?.includes("text/html")
              ) {
                const html = await response.text();
                res.statusCode = response.status;
                res.setHeader("content-type", "text/html");
                res.end(await viteDevServer.transformIndexHtml("/", html));
              } else {
                toResponse(response, res);
              }
            }
          } catch (error) {
            next(error);
          }
        });
      };
    },
    config: () => {
      return {
        ssr: {
          target: "webworker",
          resolve: {
            conditions: ["worker", "workerd", "browser"],
          },
          noExternal: Array.from(globals.__noExternalModules),
        },
        resolve: {
          mainFields: ["browser", "module", "main"],
        },
      };
    },
  };
  return plugin;
}

export function toRequest(nodeReq: Connect.IncomingMessage): MiniflareRequest {
  const origin =
    nodeReq.headers.origin && "null" !== nodeReq.headers.origin
      ? nodeReq.headers.origin
      : `http://${nodeReq.headers.host}`;
  const url = new URL(nodeReq.originalUrl!, origin);

  const headers = Object.entries(nodeReq.headers).reduce(
    (headers, [key, value]) => {
      if (Array.isArray(value)) {
        value.forEach((v) => headers.append(key, v));
      } else if (typeof value === "string") {
        headers.append(key, value);
      }
      return headers;
    },
    new Headers()
  );

  const init: RequestInit = {
    method: nodeReq.method,
    headers,
  };

  if (nodeReq.method !== "GET" && nodeReq.method !== "HEAD") {
    init.body = nodeReq;
    (init as { duplex: "half" }).duplex = "half";
  }

  return new MiniflareRequest(url, init);
}

export async function toResponse(
  res: MiniflareResponse,
  nodeRes: ServerResponse
) {
  nodeRes.statusCode = res.status;
  nodeRes.statusMessage = res.statusText;
  nodeRes.writeHead(res.status, Object.fromEntries(res.headers.entries()));
  if (res.body) {
    const readable = Readable.from(
      res.body as unknown as AsyncIterable<Uint8Array>
    );
    readable.pipe(nodeRes);
    await once(readable, "end");
  } else {
    nodeRes.end();
  }
}
