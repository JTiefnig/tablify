import * as esbuild from "esbuild";
import { rmSync } from "node:fs";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

rmSync("dist", { recursive: true, force: true });

/** @type {esbuild.BuildOptions} */
const common = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: "info",
};

const contexts = await Promise.all([
  esbuild.context({
    ...common,
    entryPoints: ["src/extension.ts"],
    outfile: "dist/extension.cjs",
    platform: "node",
    format: "cjs",
    target: "node18",
    external: ["vscode"],
    // jsonc-parser's UMD build uses dynamic requires that esbuild cannot bundle.
    mainFields: ["module", "main"],
  }),
  esbuild.context({
    ...common,
    entryPoints: { webview: "webview/main.ts" },
    outdir: "dist",
    platform: "browser",
    format: "iife",
    target: "es2022",
    loader: { ".css": "css" },
  }),
]);

if (watch) {
  await Promise.all(contexts.map((ctx) => ctx.watch()));
} else {
  await Promise.all(contexts.map((ctx) => ctx.rebuild()));
  await Promise.all(contexts.map((ctx) => ctx.dispose()));
}
