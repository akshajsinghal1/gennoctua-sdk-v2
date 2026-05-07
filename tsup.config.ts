import { defineConfig } from "tsup";

const define = {
  SDK_VERSION: JSON.stringify(process.env.npm_package_version ?? "0.1.0"),
};

export default defineConfig([
  // npm package — ESM + CJS with types
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    treeshake: true,
    sourcemap: true,
    target: "es2020",
    platform: "browser",
    define,
  },
  // CDN bundle — single IIFE file, window.Personalize
  {
    entry: { "personalize.min": "src/cdn.ts" },
    format: ["iife"],
    globalName: "Personalize",
    dts: false,
    clean: false,
    treeshake: true,
    sourcemap: false,
    minify: true,
    target: "es2017",
    platform: "browser",
    define,
    outDir: "dist/cdn",
  },
]);
