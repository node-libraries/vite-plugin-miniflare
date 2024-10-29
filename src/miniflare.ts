import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { build } from "esbuild";
import {
  Miniflare,
  mergeWorkerOptions,
  MiniflareOptions,
  Response,
} from "miniflare";
import { TransformResult, ViteDevServer } from "vite";
import { unstable_getMiniflareWorkerOptions } from "wrangler";
import { unsafeModuleFallbackService } from "./unsafeModuleFallbackService.js";

async function getTransformedModule(modulePath: string) {
  const result = await build({
    entryPoints: [modulePath],
    bundle: true,
    format: "esm",
    minify: false,
    write: false,
  });
  return result.outputFiles[0].text;
}

function createEntryBuilder(viteDevServer: ViteDevServer) {
  let entryCode = "";
  let inputFiles = new Set<string>();
  let isUpdate = true;
  let transform: TransformResult | null = null;
  viteDevServer.watcher.on("change", async (file) => {
    const updatePath = path.relative(process.cwd(), file).replace(/\\/g, "/");
    if (inputFiles.has(updatePath)) {
      isUpdate = true;
    }
  });

  return async (
    modulePath: string,
    onDependent?: (files: string[]) => void
  ) => {
    if (!isUpdate) {
      return transform;
    }
    const result = await getTransformedEntry(
      modulePath,
      viteDevServer.config.base
    );
    entryCode = result.outputFiles[0].text;
    const newInputFiles = new Set(Object.keys(result.metafile.inputs));
    if (
      newInputFiles.size !== inputFiles.size ||
      [...newInputFiles].some((file) => !inputFiles.has(file))
    ) {
      onDependent?.([...newInputFiles].map((file) => path.resolve(file)));
    }
    inputFiles = newInputFiles;
    isUpdate = false;
    transform = await viteDevServer.ssrTransform(entryCode, null, modulePath);
    return transform;
  };
}

async function getTransformedEntry(modulePath: string, baseUrl: string) {
  const result = await build({
    entryPoints: [modulePath],
    format: "esm",
    platform: "browser",
    external: ["*.wasm", "virtual:*"],
    conditions: ["worker", "workerd", "browser"],
    bundle: true,
    minify: false,
    write: false,
    logLevel: "error",
    jsxDev: true,
    metafile: true,
    banner: {
      js: `import.meta.env={BASE_URL: '${baseUrl}',DEV: true,MODE: 'development',PROD: false, SSR: true};`,
    },
    plugins: [
      {
        name: "wasm-path-fix",
        setup(build) {
          build.onResolve({ filter: /\.wasm$/ }, (args) => {
            return {
              path: path.resolve(args.resolveDir, args.path),
              namespace: "wasm",
              external: true,
            };
          });
        },
      },
    ],
  });
  return result;
}

export const createMiniflare = async ({
  viteDevServer,
  miniflareOptions,
  bundle,
  onDependent,
}: {
  viteDevServer: ViteDevServer;
  miniflareOptions?: MiniflareOptions;
  bundle?: boolean;
  onDependent?: (files: string[]) => void;
}) => {
  const isTsFile = fs.existsSync(
    path.resolve(import.meta.dirname, "miniflare_module.ts")
  );
  const modulePath = path.resolve(
    import.meta.dirname,
    isTsFile ? "miniflare_module.ts" : "miniflare_module.js"
  );
  const code = await getTransformedModule(modulePath);
  const config = fs.existsSync("wrangler.toml")
    ? unstable_getMiniflareWorkerOptions("wrangler.toml")
    : { workerOptions: {} };
  const entryBuilder = createEntryBuilder(viteDevServer);
  const _miniflareOptions: MiniflareOptions = {
    compatibilityDate: "2024-08-21",
    compatibilityFlags: ["nodejs_compat"],
    cachePersist: ".wrangler",
    modulesRoot: fileURLToPath(new URL("./", import.meta.url)),
    modules: [
      {
        path: modulePath,
        type: "ESModule",
        contents: code,
      },
    ],
    unsafeUseModuleFallbackService: true,
    unsafeModuleFallbackService: (request) =>
      unsafeModuleFallbackService(viteDevServer, request),
    unsafeEvalBinding: "__viteUnsafeEval",
    bindings: {
      __miniflare: true,
    },
    d1Persist: "./.wrangler/state/v3/d1",
    serviceBindings: {
      __viteFetchModule: async (request) => {
        const args = (await request.json()) as Parameters<
          typeof viteDevServer.environments.ssr.fetchModule
        >;
        const file = args[0];
        if (
          file.endsWith(".wasm") ||
          file.startsWith("node:") ||
          file.startsWith("cloudflare:") ||
          file.startsWith("virtual:")
        ) {
          return new Response(
            JSON.stringify({
              externalize: file,
              type: "module",
            })
          );
        }
        if (bundle) {
          const result = await entryBuilder(file, onDependent);
          if (!result) {
            throw new Error("esbuild error");
          }
          return new Response(
            JSON.stringify({
              ...result,
              file,
              id: file,
              url: file,
              invalidate: false,
            })
          );
        }

        const result = await viteDevServer.environments.ssr.fetchModule(
          ...args
        );
        return new Response(JSON.stringify(result));
      },
    },
  };
  if (
    "compatibilityDate" in config.workerOptions &&
    !config.workerOptions.compatibilityDate
  ) {
    delete config.workerOptions.compatibilityDate;
  }
  const options = mergeWorkerOptions(
    miniflareOptions
      ? mergeWorkerOptions(_miniflareOptions, miniflareOptions)
      : _miniflareOptions,
    config.workerOptions
  ) as MiniflareOptions;
  const miniflare = new Miniflare(options);
  return miniflare;
};
