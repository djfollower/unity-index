#!/usr/bin/env node
// Build the VSIX into the shared build/distributions folder so it sits next
// to the Rider plugin's unity-index-rider-<ver>.zip with matching naming.
//
//   npm run package           → ../build/distributions/unity-index-vscode-<ver>.vsix
//   npm run package -- --install   → also code --install-extension

const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");

const pkg = require(path.resolve(__dirname, "..", "package.json"));
const version = pkg.version;
const repoRoot = path.resolve(__dirname, "..", "..");
const outDir = path.join(repoRoot, "build", "distributions");
const outFile = path.join(outDir, `unity-index-vscode-${version}.vsix`);

fs.mkdirSync(outDir, { recursive: true });

// Build the graph webview bundle and copy it into dist/graph/ so vsce picks
// it up. Has to happen before vsce because vsce just zips what it finds.
function buildAndCopyGraphBundle() {
  const buildArgs = ["-w", "@unity-index/graph-webview", "run", "build"];
  console.log(`npm ${buildArgs.join(" ")}`);
  const build = spawnSync("npm", buildArgs, {
    stdio: "inherit",
    cwd: repoRoot,
    shell: process.platform === "win32",
  });
  if (build.status !== 0) {
    process.exit(build.status ?? 1);
  }

  const graphSrc = path.join(repoRoot, "graph", "webview", "dist");
  const graphDest = path.join(__dirname, "..", "dist", "graph");
  if (!fs.existsSync(graphSrc)) {
    console.error(`graph bundle not found at ${graphSrc} after build`);
    process.exit(1);
  }
  fs.rmSync(graphDest, { recursive: true, force: true });
  fs.mkdirSync(graphDest, { recursive: true });
  // Node 16.7+ — repo is on 24. Source maps get filtered out at .vscodeignore
  // level (**/*.map).
  fs.cpSync(graphSrc, graphDest, { recursive: true });
  console.log(`copied graph bundle → ${path.relative(repoRoot, graphDest)}`);
}

buildAndCopyGraphBundle();

// --no-dependencies: this extension has no runtime npm dependencies (only
// `vscode` from the host + Node built-ins). Under npm workspaces, vsce's
// dependency walk reaches into the hoisted root node_modules and produces
// paths like `../settings.gradle.kts` that crash packaging. If a real runtime
// dep is ever added, switch to bundling (esbuild) and keep this flag.
const vsceArgs = ["vsce", "package", "--no-dependencies", "--out", outFile];
console.log(`npx ${vsceArgs.join(" ")}`);
const result = spawnSync("npx", vsceArgs, {
  stdio: "inherit",
  cwd: path.resolve(__dirname, ".."),
  shell: process.platform === "win32",
});
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

if (process.argv.includes("--install")) {
  console.log(`code --install-extension ${outFile}`);
  const install = spawnSync("code", ["--install-extension", outFile], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (install.status !== 0) process.exit(install.status ?? 1);
}
