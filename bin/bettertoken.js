#!/usr/bin/env node
const { execSync } = require("child_process");
const path = require("path");

const cli = path.join(__dirname, "..", "src", "cli.ts");

// Try bun first (handles .ts natively), fall back to node with tsx
const bunPaths = [
  "bun",
  path.join(process.env.USERPROFILE || process.env.HOME || "", ".bun", "bin", "bun"),
  path.join(process.env.APPDATA || "", "npm", "bun.cmd"),
];

let ran = false;
for (const bun of bunPaths) {
  try {
    execSync(`"${bun}" "${cli}" ${process.argv.slice(2).join(" ")}`, {
      stdio: "inherit",
      env: process.env,
    });
    ran = true;
    break;
  } catch (e) {
    if (e.status !== null) {
      // bun was found but the script errored - propagate exit code
      process.exit(e.status);
    }
    // bun not found at this path, try next
  }
}

if (!ran) {
  console.error("Could not find bun. Install it: https://bun.sh");
  console.error("Or run directly: bun " + cli + " " + process.argv.slice(2).join(" "));
  process.exit(1);
}
