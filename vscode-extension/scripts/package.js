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
const outDir = path.resolve(__dirname, "..", "..", "build", "distributions");
const outFile = path.join(outDir, `unity-index-vscode-${version}.vsix`);

fs.mkdirSync(outDir, { recursive: true });

const vsceArgs = ["vsce", "package", "--out", outFile];
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
