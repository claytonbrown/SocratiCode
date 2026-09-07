// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const expectedCommand = "npx";
const expectedArgs = ["-y", "--prefer-online", "socraticode@latest"];

function readText(relativePath: string): string {
  return readFileSync(join(projectRoot, relativePath), "utf8");
}

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(readText(relativePath)) as Record<string, unknown>;
}

function expectLauncher(server: Record<string, unknown>, source: string): void {
  expect(server.command, `${source} command`).toBe(expectedCommand);
  expect(server.args, `${source} args`).toEqual(expectedArgs);
}

describe("distributed MCP launchers", () => {
  it("uses the update-aware launcher in every bundled MCP definition", () => {
    for (const relativePath of [".mcp.json", "mcp.json", "gemini-extension.json"]) {
      const config = readJson(relativePath);
      const servers = config.mcpServers as Record<string, Record<string, unknown>>;
      expectLauncher(servers.socraticode, relativePath);
    }
  });

  it("keeps the VS Code manifest and runtime fallback aligned", () => {
    const manifest = readJson("extension/package.json");
    const contributes = manifest.contributes as Record<string, unknown>;
    const configuration = contributes.configuration as Record<string, unknown>;
    const properties = configuration.properties as Record<string, Record<string, unknown>>;

    expect(properties["socraticode.command"].default).toBe(expectedCommand);
    expect(properties["socraticode.args"].default).toEqual(expectedArgs);

    const settingsSource = readText("extension/src/settings.ts");
    expect(settingsSource).toContain(
      'c.get<string[]>("args", ["-y", "--prefer-online", "socraticode@latest"])',
    );
  });

  it("encodes the same launcher in every VS Code install link", () => {
    const readme = readText("README.md");
    const links = readme.match(
      /https:\/\/(?:insiders\.)?vscode\.dev\/redirect\/mcp\/install\?[^)"\s]+/g,
    );

    expect(links?.length).toBe(4);
    for (const link of links ?? []) {
      const config = new URL(link).searchParams.get("config");
      expect(config, link).not.toBeNull();
      expectLauncher(JSON.parse(config ?? "{}") as Record<string, unknown>, link);
    }
  });

  it("encodes the same launcher in every Cursor install link", () => {
    const readme = readText("README.md");
    const links = readme.match(
      /cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install\?[^)"\s]+/g,
    );

    expect(links?.length).toBe(2);
    for (const link of links ?? []) {
      const encodedConfig = new URL(link).searchParams.get("config");
      expect(encodedConfig, link).not.toBeNull();
      const config = JSON.parse(Buffer.from(encodedConfig ?? "", "base64").toString("utf8")) as Record<
        string,
        unknown
      >;
      expectLauncher(config, link);
    }
  });

  it("does not retain the former cached launcher in shipped guidance", () => {
    for (const relativePath of [
      "README.md",
      "DEVELOPER.md",
      "extension/README.md",
      "extension/src/mcpProvider.ts",
    ]) {
      const contents = readText(relativePath);
      expect(contents, relativePath).not.toMatch(/npx -y socraticode(?:@latest)?/);
      expect(contents, relativePath).not.toContain('["-y", "socraticode"]');
      expect(contents, relativePath).not.toContain('["npx", "-y", "socraticode"]');
    }
  });
});
