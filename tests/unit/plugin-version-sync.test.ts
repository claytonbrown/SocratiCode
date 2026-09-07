// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const manifestPaths = [
  ".claude-plugin/plugin.json",
  ".cursor-plugin/plugin.json",
  ".codex-plugin/plugin.json",
  "gemini-extension.json",
  "extension/package.json",
  "extension/package-lock.json",
];

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

describe("plugin and extension version synchronisation", () => {
  it("keeps every shipped manifest aligned with the package version", () => {
    const packageVersion = readJson(join(projectRoot, "package.json")).version;

    for (const relativePath of manifestPaths) {
      const manifest = readJson(join(projectRoot, relativePath));
      expect(manifest.version, relativePath).toBe(packageVersion);

      if (relativePath.endsWith("package-lock.json")) {
        const packages = manifest.packages as Record<string, Record<string, unknown>>;
        expect(packages[""].version, `${relativePath} root package`).toBe(packageVersion);
      }
    }
  });

  it("bumps Gemini and the extension lockfile with the other manifests", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "socraticode-version-sync-"));
    temporaryDirectories.push(fixtureRoot);

    for (const relativePath of manifestPaths) {
      const path = join(fixtureRoot, relativePath);
      mkdirSync(dirname(path), { recursive: true });
      const manifest = relativePath.endsWith("package-lock.json")
        ? { version: "0.0.0", packages: { "": { version: "0.0.0" } } }
        : { version: "0.0.0" };
      writeFileSync(path, `${JSON.stringify(manifest)}\n`);
    }

    execFileSync(
      process.execPath,
      [join(projectRoot, "scripts/bump-plugin-versions.mjs"), "9.9.9"],
      { cwd: fixtureRoot },
    );

    for (const relativePath of manifestPaths) {
      const manifest = readJson(join(fixtureRoot, relativePath));
      expect(manifest.version, relativePath).toBe("9.9.9");
      if (relativePath.endsWith("package-lock.json")) {
        const packages = manifest.packages as Record<string, Record<string, unknown>>;
        expect(packages[""].version).toBe("9.9.9");
      }
    }
  });

  it("updates an npm v1 lockfile without a packages map", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "socraticode-version-sync-v1-"));
    temporaryDirectories.push(fixtureRoot);
    const lockfilePath = join(fixtureRoot, "extension/package-lock.json");
    mkdirSync(dirname(lockfilePath), { recursive: true });
    writeFileSync(
      lockfilePath,
      `${JSON.stringify({ name: "socraticode", version: "0.0.0", lockfileVersion: 1 })}\n`,
    );

    execFileSync(
      process.execPath,
      [join(projectRoot, "scripts/bump-plugin-versions.mjs"), "9.9.9"],
      { cwd: fixtureRoot },
    );

    expect(readJson(lockfilePath).version).toBe("9.9.9");
  });
});
