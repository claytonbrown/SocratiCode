// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildCodeGraph, ensureDynamicLanguages, getGraphableFiles } from "../../src/services/code-graph.js";
import { logger } from "../../src/services/logger.js";
import { canTestPermissionDenied } from "../helpers/fixtures.js";

// Regression for the whitelist .gitignore discovery fix: a `/*` then `!/src/`
// pattern ignores everything at the root but re-includes `src/`. The old walk
// passed `src` (no trailing slash) to shouldIgnore, which `/*` matched, so the
// walk bailed and produced an empty graph. Passing `src/` lets it descend and
// the files under the re-included directory are actually picked up.
describe("getGraphableFiles — whitelist .gitignore", () => {
  let root: string;

  beforeAll(() => {
    ensureDynamicLanguages();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "socraticode-discovery-"));
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, ".gitignore"), "/*\n!/src/\n");
    fs.writeFileSync(
      path.join(root, "src", "mod.lua"),
      "local function f()\n  return 1\nend\nreturn f\n",
    );
    // A root-level file the `/*` pattern should keep ignored.
    fs.writeFileSync(path.join(root, "ignored.lua"), "return 1\n");
  });

  afterAll(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("descends into re-included src/ and discovers its files", async () => {
    const { files } = await getGraphableFiles(root);
    expect(files).toContain("src/mod.lua");
    // The `/*` pattern still ignores top-level entries that are not re-included.
    expect(files).not.toContain("ignored.lua");
  });
});

describe("getGraphableFiles / buildCodeGraph — extensionless", () => {
  let root: string;

  beforeAll(() => {
    ensureDynamicLanguages();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "socraticode-graph-extless-"));
    // No-shebang Python (waf wscript) — grammar-bearing → graph-eligible.
    fs.writeFileSync(
      path.join(root, "wscript"),
      "def configure(conf):\n    return 1\n\ndef build(bld):\n    return configure(bld)\n",
    );
    // perl shebang → detected as .txt → grammar-less → NOT in graph.
    fs.writeFileSync(path.join(root, "helper"), "#!/usr/bin/perl\nprint 1;\n");
    // Non-code extensionless → not in graph.
    fs.writeFileSync(path.join(root, "NOTICE"), "All rights reserved.\n");
    // SPECIAL_FILE with a shell recipe: must NOT be content-detected into the
    // graph as a shell node (handled by name elsewhere).
    fs.writeFileSync(
      path.join(root, "Makefile"),
      "build:\n\tset -euo pipefail\n\tif [ -f foo ]; then \\\n\t\techo yes; \\\n\tfi\n",
    );
    // Extensionless dotfile with shell content: sniffs to .sh, but the index
    // (glob dot:false) never sees it, so the graph must skip it too.
    fs.writeFileSync(
      path.join(root, ".profile"),
      'set -eu\nif [ -d "$HOME/bin" ]; then\n  export PATH="$HOME/bin"\nfi\n',
    );
    // Extensioned file: admitted by extension alone, so detection never runs and
    // it must carry no detectedExts entry.
    fs.writeFileSync(path.join(root, "mod.py"), "def f():\n    return 1\n");
  });

  afterAll(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("includes grammar-bearing extensionless files, excludes .txt-detected and non-code", async () => {
    const { files } = await getGraphableFiles(root);
    expect(files).toContain("wscript");
    expect(files).not.toContain("helper"); // .txt — grammar-less, stays out of graph
    expect(files).not.toContain("NOTICE");
    expect(files).not.toContain("Makefile"); // SPECIAL_FILE — never content-detected
    expect(files).not.toContain(".profile"); // extensionless dotfile — matches index dot:false policy
  });

  it("excludes all extensionless files when INDEX_EXTENSIONLESS=false", async () => {
    vi.stubEnv("INDEX_EXTENSIONLESS", "false");
    try {
      const { files } = await getGraphableFiles(root);
      expect(files).not.toContain("wscript");
      expect(files).not.toContain("helper");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("includes a detected extensionless dotfile when INCLUDE_DOT_FILES=true", async () => {
    vi.stubEnv("INCLUDE_DOT_FILES", "true");
    try {
      const { files } = await getGraphableFiles(root);
      expect(files).toContain(".profile"); // shell dotfile now admitted (matches the index)
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("extracts symbols for a detected extensionless Python file", async () => {
    const graph = await buildCodeGraph(root);
    const symbols = graph.symbolsByFile.get("wscript");
    expect(symbols).toBeDefined();
    expect((symbols ?? []).map((s) => s.name)).toEqual(expect.arrayContaining(["configure", "build"]));
  });

  it("carries the discovery-detected extension for admitted extensionless files", async () => {
    const { files, detectedExts } = await getGraphableFiles(root);
    expect(files).toContain("wscript");
    expect(detectedExts.get("wscript")).toBe(".py");
    // Extensioned files are admitted by extension, so detection never ran.
    expect(files).toContain("mod.py");
    expect(detectedExts.has("mod.py")).toBe(false);
    // Rejected extensionless files carry no entry either.
    expect(detectedExts.has("NOTICE")).toBe(false);
  });

  it("returns files in lexicographic order", async () => {
    // wscript is written before mod.py above, so this fails on a filesystem that
    // yields creation order. Where readdir is already sorted it cannot fail —
    // the interleaving test below is the one that pins the sort on those.
    const { files } = await getGraphableFiles(root);
    expect(files).toEqual(["mod.py", "wscript"]);
  });
});

// The half of the sort's job that is observable on every filesystem, sorted
// readdir included: a depth-first walk yields a directory's contents before the
// sibling entries that sort after it, because "/" (0x2F) sorts after "." (0x2E).
// So the raw traversal order is not lexicographic even when each readdir is.
describe("getGraphableFiles — depth-first interleaving", () => {
  let root: string;

  beforeAll(() => {
    ensureDynamicLanguages();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "socraticode-discovery-order-"));
    fs.mkdirSync(path.join(root, "a"), { recursive: true });
    fs.writeFileSync(path.join(root, "a", "x.py"), "def x():\n    return 1\n");
    fs.writeFileSync(path.join(root, "a.py"), "def y():\n    return 2\n");
  });

  afterAll(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("puts a.py before a/x.py, the opposite of what the walk yields", async () => {
    const { files } = await getGraphableFiles(root);
    expect(files).toEqual(["a.py", "a/x.py"]);
  });
});

// A directory the walk cannot read takes its whole subtree out of the file list
// before any of those files has a path to report, so they never reach the build
// loop's skip accounting. The log is the only trace, which is what this pins.
describe("getGraphableFiles — unreadable directory", () => {
  let root: string;
  let locked: string;

  beforeAll(() => {
    ensureDynamicLanguages();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "socraticode-discovery-eacces-"));
    fs.writeFileSync(path.join(root, "top.py"), "def a():\n    return 1\n");
    locked = path.join(root, "locked");
    fs.mkdirSync(locked, { recursive: true });
    fs.writeFileSync(path.join(locked, "hidden.py"), "def b():\n    return 2\n");
  });

  afterAll(() => {
    try {
      fs.chmodSync(locked, 0o755);
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it.skipIf(!canTestPermissionDenied)(
    "logs the directory and omits its subtree",
    async () => {
      const debug = vi.spyOn(logger, "debug");
      fs.chmodSync(locked, 0o000);
      try {
        const { files } = await getGraphableFiles(root);

        expect(files).toEqual(["top.py"]);
        expect(debug).toHaveBeenCalledWith(
          "Could not read directory in graph discovery (subtree omitted)",
          expect.objectContaining({ dir: "locked", error: expect.stringContaining("EACCES") }),
        );
      } finally {
        fs.chmodSync(locked, 0o755);
        debug.mockRestore();
      }
    },
  );
});

// Sorting discovery output also settles buildJvmSuffixMap's tie-break for a class
// path that two modules both provide: it keeps the first path it sees, so the
// winner is the lexicographically first module rather than whichever the walk
// reached first. "mod-b/…" sorts before "mod/…" ("-" 0x2D < "/" 0x2F) while the
// walk descends "mod" first, so the two orders disagree on this fixture.
describe("buildCodeGraph — duplicate JVM class path tie-break", () => {
  let root: string;

  beforeAll(() => {
    ensureDynamicLanguages();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "socraticode-jvm-tiebreak-"));
    for (const module of ["mod", "mod-b"]) {
      const dir = path.join(root, module, "src", "main", "java", "com", "example");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "Foo.java"), "package com.example;\n\npublic class Foo {}\n");
    }
    const appDir = path.join(root, "app", "src", "main", "java", "com", "other");
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      path.join(appDir, "App.java"),
      "package com.other;\n\nimport com.example.Foo;\n\npublic class App {}\n",
    );
  });

  afterAll(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("resolves a duplicated class to the lexicographically first module", async () => {
    const graph = await buildCodeGraph(root);
    const app = graph.nodes.find(
      (n) => n.relativePath === "app/src/main/java/com/other/App.java",
    );
    expect(app?.dependencies).toEqual(["mod-b/src/main/java/com/example/Foo.java"]);
  });
});

// ── Go module resolution through the real pipeline (#45 root + #82 nested) ─
// These drive the actual getGraphableFiles → buildCodeGraph path, where
// go.mod is NOT part of the graphable file set (it has no AST grammar).
// The first #82 attempt scanned the file set for go.mod and so produced 0
// edges for EVERY Go project — root or nested — while its hand-built unit
// tests stayed green. These end-to-end checks fail under that approach.
function writeLayout(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "socraticode-go-e2e-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

describe("buildCodeGraph — Go module resolution (issues #45 & #82)", () => {
  const roots: string[] = [];

  afterAll(() => {
    for (const r of roots) {
      try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  // Confirms getGraphableFiles admits the .go files (it does) and that
  // buildCodeGraph then builds Go edges — independent of any unit test's
  // hand-built file set.
  async function buildGraph(layout: Record<string, string>): Promise<ReturnType<typeof buildCodeGraph>> {
    const dir = writeLayout(layout);
    roots.push(dir);
    return buildCodeGraph(dir);
  }

  it("produces Go edges when go.mod is at the indexed root (#45 still works)", async () => {
    const graph = await buildGraph({
      "go.mod": "module github.com/example/myapp\n\ngo 1.22\n",
      "main.go": [
        "package main",
        "",
        "import \"github.com/example/myapp/internal/middleware\"",
        "",
        "func main() {",
        "\tif middleware.Authorize(\"admin\") {}",
        "}",
      ].join("\n"),
      "internal/middleware/auth.go": [
        "package middleware",
        "",
        "func Authorize(role string) bool { return role == \"admin\" }",
      ].join("\n"),
    });

    // The root-level module path resolves the import to a real file and an
    // edge is created. This is the #45 behavior that must not regress.
    expect(graph.edges.length).toBeGreaterThan(0);
    expect(
      graph.edges.some(
        (e) => e.source === "main.go" && e.target === "internal/middleware/auth.go",
      ),
    ).toBe(true);
  });

  it("produces Go edges when go.mod is nested below the indexed root (#82)", async () => {
    // The exact monorepo shape from the issue: go.mod lives in `backend/`,
    // one level below the path passed to buildCodeGraph.
    const graph = await buildGraph({
      "docker-compose.yml": "services: {}\n",
      "frontend/src/app.ts": "export const x = 1;\n",
      "backend/go.mod": "module github.com/example/myapp-backend\n\ngo 1.22\n",
      "backend/internal/middleware/auth.go": [
        "package middleware",
        "",
        "func Authorize(role string) bool { return role == \"admin\" }",
      ].join("\n"),
      "backend/internal/service/user.go": [
        "package service",
        "",
        "import \"github.com/example/myapp-backend/internal/middleware\"",
        "",
        "func CanDeleteUser(role string) bool {",
        "\treturn middleware.Authorize(role)",
        "}",
      ].join("\n"),
      "backend/cmd/server/main.go": [
        "package main",
        "",
        "import (",
        "\t\"github.com/example/myapp-backend/internal/middleware\"",
        "\t\"github.com/example/myapp-backend/internal/service\"",
        ")",
        "",
        "func main() {",
        "\tif middleware.Authorize(\"admin\") {",
        "\t\t_ = service.CanDeleteUser(\"admin\")",
        "\t}",
        "}",
      ].join("\n"),
    });

    // Non-Go files are unaffected and still produce edges.
    expect(graph.edges.some((e) => e.source === "frontend/src/app.ts")).toBe(false);

    // The nested module is discovered from disk (go.mod is not graphable)
    // and both cross-package imports resolve to real edges.
    expect(graph.edges.length).toBeGreaterThan(0);
    expect(
      graph.edges.some(
        (e) =>
          e.source === "backend/cmd/server/main.go" &&
          e.target === "backend/internal/middleware/auth.go",
      ),
    ).toBe(true);
    expect(
      graph.edges.some(
        (e) =>
          e.source === "backend/internal/service/user.go" &&
          e.target === "backend/internal/middleware/auth.go",
      ),
    ).toBe(true);
  });

  it("resolves a nested module under a single-character dir `z/` (depth tie-break)", async () => {
    // Root module `github.com/example/root` + nested `github.com/example/z`
    // under `z/`. A string-length tie-break (`.` and `z` are both length 1)
    // can mis-attribute `z/` files to the root; directory depth must not.
    const graph = await buildGraph({
      "go.mod": "module github.com/example/root\n\ngo 1.22\n",
      "main.go": "package main\n\nfunc main() {}\n",
      "z/go.mod": "module github.com/example/z\n\ngo 1.22\n",
      "z/svc/bar.go": "package svc\n\nfunc Bar() {}\n",
      "z/caller/main.go": [
        "package main",
        "",
        "import \"github.com/example/z/svc\"",
        "",
        "func main() { _ = svc.Bar() }",
      ].join("\n"),
    });

    // The `z/` module owns its files (depth 1 > root depth 0), so the
    // import `github.com/example/z/svc` resolves to z/svc/bar.go and an edge
    // is created. Under the buggy string-length tie-break this would either
    // fail to resolve or attribute the edge to the root module.
    expect(
      graph.edges.some(
        (e) => e.source === "z/caller/main.go" && e.target === "z/svc/bar.go",
      ),
    ).toBe(true);
  });

  it("discovers a symlinked go.mod (no symlink regression vs the old single read)", async () => {
    // readdirSync Dirents don't follow symlinks: a symlinked go.mod reports
    // isFile()===false. The old root-level readFileSync DID follow it, so the
    // new tree walk must too — otherwise a root-level symlinked go.mod
    // regresses to 0 edges (PR #84 review).
    const target = fs.mkdtempSync(path.join(os.tmpdir(), "socraticode-go-symlink-src-"));
    roots.push(target);
    const realGoMod = path.join(target, "go.mod.real");
    fs.writeFileSync(realGoMod, "module github.com/example/symlinked\n\ngo 1.22\n");

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "socraticode-go-e2e-"));
    roots.push(dir);
    // go.mod is a symlink to a file OUTSIDE the indexed tree.
    fs.symlinkSync(realGoMod, path.join(dir, "go.mod"));
    fs.writeFileSync(
      path.join(dir, "main.go"),
      [
        "package main",
        "",
        'import "github.com/example/symlinked/internal/middleware"',
        "",
        'func main() { _ = middleware.Authorize("admin") }',
      ].join("\n"),
    );
    fs.mkdirSync(path.join(dir, "internal", "middleware"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "internal", "middleware", "auth.go"),
      [
        "package middleware",
        "",
        'func Authorize(role string) bool { return role == "admin" }',
      ].join("\n"),
    );

    const graph = await buildCodeGraph(dir);
    expect(
      graph.edges.some(
        (e) => e.source === "main.go" && e.target === "internal/middleware/auth.go",
      ),
    ).toBe(true);
  });

  it("ignores a stray go.mod under a default-ignored dir (build/) so it can't shadow the real module", async () => {
    // findGoModFiles reuses createIgnoreFilter; `build/` is in the default
    // skip list (and hard-skipped in findNestedGitignores). If discovery ever
    // bypassed the filter, the stray build/go.mod — declaring the SAME module
    // path as the root and alphabetically first — would win module selection
    // in resolveImport with an empty package map and silently drop every edge:
    // the same silent-zero-edge class #82 fixes. This case fails the moment
    // shouldIgnore is stubbed to a no-op.
    const graph = await buildGraph({
      "go.mod": "module github.com/example/myapp\n\ngo 1.22\n",
      "main.go": [
        "package main",
        "",
        'import "github.com/example/myapp/internal/middleware"',
        "",
        'func main() { _ = middleware.Authorize("admin") }',
      ].join("\n"),
      "internal/middleware/auth.go": [
        "package middleware",
        "",
        'func Authorize(role string) bool { return role == "admin" }',
      ].join("\n"),
      // Stray module under an ignored dir: same module path as the root, so it
      // would shadow the root module if discovery ever picked it up.
      "build/go.mod": "module github.com/example/myapp\n\ngo 1.22\n",
    });

    expect(
      graph.edges.some(
        (e) => e.source === "main.go" && e.target === "internal/middleware/auth.go",
      ),
    ).toBe(true);
  });
});

// ── Rust crate resolution through the real pipeline ───────────────────────
// Cargo.toml has no AST grammar, so it is never in the graphable file set —
// the same trap #82 documents for go.mod. These drive the real
// getGraphableFiles → buildCodeGraph path over a workspace laid out the way
// Cargo generates one, where every edge below was absent before crate roots
// were read.
describe("buildCodeGraph — Rust crate resolution", () => {
  const roots: string[] = [];
  let graph: Awaited<ReturnType<typeof buildCodeGraph>>;

  beforeAll(async () => {
    ensureDynamicLanguages();
    const dir = writeLayout({
      "Cargo.toml": '[workspace]\nmembers = ["crates/cli", "crates/core"]\n',

      "crates/core/Cargo.toml":
        '[package]\nname = "app-core"\nedition = "2021"\n\n[dependencies]\nserde = "1"\n',
      // `serde` names both a dependency and a module this file declares. The
      // declaration is what rustc resolves the path through, so the edge into
      // the local module has to be drawn — a resolver that answers "no edge"
      // to every path carrying a dependency's name would pass the third-party
      // test below and fail here.
      "crates/core/src/lib.rs": [
        "pub mod store;",
        "pub mod serde;",
        "",
        "pub use store::Store;",
        "pub use serde::Local;",
      ].join("\n"),
      "crates/core/src/serde.rs": "pub struct Local;",
      "crates/core/src/store.rs": [
        "mod open;",
        "mod support;",
        "",
        "pub struct Store;",
        "pub struct StoreError;",
      ].join("\n"),
      "crates/core/src/store/open.rs": [
        "use super::Store;",
        "mod detail;",
        "",
        "pub fn open() -> Store { Store }",
      ].join("\n"),
      "crates/core/src/store/support.rs": "pub fn helper() {}",
      // A test block two levels down: `super` inside it counts from the file,
      // so reaching `store::support` from here takes one climb more than the
      // file's own depth suggests.
      "crates/core/src/store/open/detail.rs": [
        "pub fn detail() {}",
        "",
        "#[cfg(test)]",
        "mod tests {",
        "    use super::*;",
        "    use super::super::super::support::helper;",
        "",
        "    #[test]",
        "    fn works() { detail(); helper(); }",
        "}",
      ].join("\n"),

      // `app-core` declared, as rustc requires for the sibling to be in
      // scope at all: a package reaches only the crates its manifest names.
      "crates/cli/Cargo.toml":
        '[package]\nname = "app-cli"\nedition = "2021"\n\n[dependencies]\nserde = "1"\napp-core = { path = "../core" }\n',
      "crates/cli/src/main.rs": [
        "mod runner;",
        "",
        "use app_core::{Store, store::StoreError};",
        "",
        "fn main() { runner::run(); }",
      ].join("\n"),
      "crates/cli/src/runner.rs": ["use serde::Deserialize;", "", "pub fn run() {}"].join("\n"),
      // A file named after the dependency, sitting right beside the importer
      // and declared by nobody. Cargo 1.70, 1.85 and 1.98 all agree an
      // undeclared file is not in the module tree and cannot capture the
      // path: `use serde::Deserialize;` reaches the crate, and the graph must
      // draw nothing at all.
      "crates/cli/src/serde.rs": "pub struct Deserialize;",
      // The same name declared one level in, inside an inline block. That
      // declaration puts `serde` in scope inside `inner` and nowhere else, so
      // the `use` written at the file's own level still reaches the
      // dependency — cargo 1.70.0 and 1.98.0 both compile that shape against
      // the dependency, and fail with E0432 when it is removed. Reading the
      // declaration as the file's own handed `crates/cli/src/serde.rs` the
      // capture back.
      "crates/cli/src/shadow.rs": [
        "use serde::Deserialize;",
        "",
        "mod inner {",
        "    mod serde;",
        "}",
        "",
        "pub fn shadowed() {}",
      ].join("\n"),
      "crates/cli/src/shadow/inner/serde.rs": "pub struct Local;",
      // A declared module and a path through it, landing on two different
      // files: the declaration draws the edge to `holder.rs`, the unanchored
      // path draws the one to `holder/child.rs`. Edges are a set, so this is
      // the only shape in which the graph can show that the collected
      // declarations reach the resolver at all — asserting the declaration's
      // own edge would stay green with the set emptied.
      "crates/cli/src/holder_user.rs": [
        "mod holder;",
        "",
        "use holder::child::Thing;",
        "",
        "pub fn make() -> Thing { Thing }",
      ].join("\n"),
      "crates/cli/src/holder_user/holder.rs": "pub mod child;",
      "crates/cli/src/holder_user/holder/child.rs": "pub struct Thing;",
      // The attribute moves the file and keeps the name: `moved` is what the
      // paths below say, `renamed.rs` is where it lives, and its own child
      // sits beside that file — `src/deeper.rs`, which is where rustc looks.
      "crates/cli/src/mover.rs": [
        '#[path = "renamed.rs"]',
        "mod moved;",
        "",
        "use moved::Item;",
        "use moved::deeper::Deep;",
        "",
        "pub fn take(a: Item, b: Deep) -> (Item, Deep) { (a, b) }",
      ].join("\n"),
      "crates/cli/src/renamed.rs": "pub mod deeper;\n\npub struct Item;",
      "crates/cli/src/deeper.rs": "pub struct Deep;",
    });
    roots.push(dir);
    graph = await buildCodeGraph(dir);
  });

  afterAll(() => {
    for (const r of roots) {
      try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  const edge = (source: string, target: string): boolean =>
    graph.edges.some((e) => e.source === source && e.target === target);

  it("follows a pub mod declaration", () => {
    expect(edge("crates/core/src/lib.rs", "crates/core/src/store.rs")).toBe(true);
  });

  it("follows super:: to a parent module living beside its directory", () => {
    expect(edge("crates/core/src/store/open.rs", "crates/core/src/store.rs")).toBe(true);
  });

  it("follows a path into a sibling crate by its Cargo name", () => {
    // `app_core::Store` is re-exported from the library root; the underscored
    // import name only reaches the dashed package because the manifest says so.
    expect(edge("crates/cli/src/main.rs", "crates/core/src/lib.rs")).toBe(true);
    // The group's other leaf names a module one level down, and lands there.
    expect(edge("crates/cli/src/main.rs", "crates/core/src/store.rs")).toBe(true);
  });

  it("follows a mod declaration inside a binary crate", () => {
    expect(edge("crates/cli/src/main.rs", "crates/cli/src/runner.rs")).toBe(true);
  });

  it("draws no edge into a crate for a third-party path", () => {
    // `runner.rs` imports `serde` and nothing else, and `crates/cli/src/serde.rs`
    // sits right beside it carrying that very name without being declared.
    // Asserting that every edge ends in a `.rs` file would hold on an empty
    // set too — and did, while the resolver was returning nothing at all; the
    // edges leaving this one file are what says the third-party path resolved
    // to nothing rather than to the same-named file next door.
    const leaving = graph.edges
      .filter((e) => e.source === "crates/cli/src/runner.rs")
      .map((e) => e.target);

    expect(leaving).toEqual([]);
    // Said the other way round, so that a resolver drawing the wrong edge is
    // named by the assertion that fails.
    expect(edge("crates/cli/src/runner.rs", "crates/cli/src/serde.rs")).toBe(false);
  });

  it("does not let a module declared inside an inline block claim the file's own scope", () => {
    // `mod inner { mod serde; }` declares `serde` inside `inner`. The `use`
    // written at the file's level is outside that block, so it reaches the
    // dependency and must draw no edge — least of all to the same-named file
    // sitting beside the importer.
    expect(edge("crates/cli/src/shadow.rs", "crates/cli/src/serde.rs")).toBe(false);
    // The declaration itself is still an edge: it names a real file one level
    // in, which is what keeps this test from passing on "no edges at all".
    expect(edge("crates/cli/src/shadow.rs", "crates/cli/src/shadow/inner/serde.rs")).toBe(
      true,
    );
  });

  it("carries the declarations a file makes all the way to the resolver", () => {
    // Two files, one declaration: `mod holder;` draws the first edge, and the
    // unanchored `use holder::child::Thing;` can only draw the second if the
    // declaration reached the resolver. Empty the collected set and this
    // second assertion fails while the first still holds.
    expect(edge("crates/cli/src/holder_user.rs", "crates/cli/src/holder_user/holder.rs")).toBe(
      true,
    );
    expect(
      edge("crates/cli/src/holder_user.rs", "crates/cli/src/holder_user/holder/child.rs"),
    ).toBe(true);
  });

  it("follows a path through a module the attribute moved", () => {
    // The declaration's own edge, and then the two the paths draw: one to the
    // moved file, one to the child sitting beside it. Before the declaration
    // carried its file, the paths found no `src/moved.rs` and drew nothing —
    // or, in a workspace holding a library of that name, drew into it.
    expect(edge("crates/cli/src/mover.rs", "crates/cli/src/renamed.rs")).toBe(true);
    expect(edge("crates/cli/src/mover.rs", "crates/cli/src/deeper.rs")).toBe(true);
  });

  it("follows a module declared with a dependency's name", () => {
    // Here `serde` is declared with `pub mod serde;`, so the file that carries
    // a dependency's name is still in the module tree and its edge belongs in
    // the graph.
    //
    // This asserts the declaration, not the `pub use serde::Local;` beside it:
    // both land on the same file, and the graph's edges are a set, so nothing
    // here can tell which of the two drew it. The hand that keeps the
    // third-party test honest — an unanchored path resolving when the module
    // is declared and not resolving when it is not — is asserted where it can
    // fail, on `resolveRustImport` itself, in
    // "lets an unanchored path reach a module the file declares, and only
    // then".
    expect(edge("crates/core/src/lib.rs", "crates/core/src/serde.rs")).toBe(true);
  });

  it("draws no edge at the parent module for a test block's glob import", () => {
    // `use super::*;` inside `#[cfg(test)] mod tests` names the file it is
    // written in. Counted from the file instead, it lands on the parent
    // module and closes a cycle with the `mod detail;` pointing the other way.
    expect(edge("crates/core/src/store/open/detail.rs", "crates/core/src/store/open.rs")).toBe(
      false,
    );
  });

  it("counts the inline test module as a level a super:: path climbs", () => {
    expect(
      edge("crates/core/src/store/open/detail.rs", "crates/core/src/store/support.rs"),
    ).toBe(true);
  });
});

// ── Edition 2015: a declaration and a use of the same name are different ──
// They arrive at the resolver as the same string, `foo`, and count from
// different places: the declaration from the declaring file's own directory,
// the use from the crate root. Measured on cargo 1.70.0 and 1.98.0 —
// `use foo::Nested;` beside `mod foo;` in `src/deep/mod.rs` is E0432, while
// `use foo::AtRoot;` compiles. Only a fixture driven through buildCodeGraph
// can show that the two are told apart, since that is where the difference is
// read off the source.
describe("buildCodeGraph — Rust edition 2015 declaration and use", () => {
  const roots: string[] = [];
  let graph: Awaited<ReturnType<typeof buildCodeGraph>>;

  beforeAll(async () => {
    ensureDynamicLanguages();
    const dir = writeLayout({
      // No edition key: Cargo reads 2015.
      "Cargo.toml": '[package]\nname = "app"\nversion = "0.1.0"\n',
      "src/lib.rs": ["mod deep;", "mod foo;"].join("\n"),
      "src/foo.rs": "pub struct AtRoot;",
      "src/deep/mod.rs": [
        "mod foo;",
        "use foo::AtRoot;",
        "",
        "pub fn take() -> AtRoot { AtRoot }",
      ].join("\n"),
      "src/deep/foo.rs": "pub struct Nested;",
    });
    roots.push(dir);
    graph = await buildCodeGraph(dir);
  });

  afterAll(() => {
    for (const r of roots) {
      try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  const edge = (source: string, target: string): boolean =>
    graph.edges.some((e) => e.source === source && e.target === target);

  it("files the declaration beside the declaring file", () => {
    expect(edge("src/deep/mod.rs", "src/deep/foo.rs")).toBe(true);
  });

  it("leaves the use to the crate root's module unresolved, a declared limit", () => {
    // In 2015 this path is absolute from the crate root and does compile, but
    // nothing in the importing file declares it. Drawing it means resolving
    // what no declaration proves, which is where every wrong edge in this
    // resolver has come from; `main` draws nothing here either.
    expect(edge("src/deep/mod.rs", "src/foo.rs")).toBe(false);
  });
});

describe("buildCodeGraph — Rust edges rustc rejects", () => {
  const roots: string[] = [];

  afterAll(() => {
    for (const r of roots) {
      try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  async function graphOf(layout: Record<string, string>): Promise<Awaited<ReturnType<typeof buildCodeGraph>>> {
    ensureDynamicLanguages();
    const dir = writeLayout(layout);
    roots.push(dir);
    return buildCodeGraph(dir);
  }

  it("draws no edge between two integration tests, which are separate crates", async () => {
    // `cargo check --tests` on this exact layout is `error[E0432]: unresolved
    // import 'b'`, with the edition key absent and with `edition = "2021"`
    // alike: two files in `tests/` are separate crates and cannot import each
    // other under any edition. The 2015 root-relative reading answers from the
    // crate root without asking for a declaration, which is right for a module
    // and wrong for another crate's root.
    const graph = await graphOf({
      "Cargo.toml": '[package]\nname = "app"\nversion = "0.1.0"\n',
      "src/lib.rs": "pub fn nothing() {}",
      "tests/a.rs": "use b::helper;\n\n#[test]\nfn t() { helper(); }",
      "tests/b.rs": "pub fn helper() {}",
    });

    expect(graph.edges.some((e) => e.source === "tests/a.rs" && e.target === "tests/b.rs")).toBe(false);
  });

  it("reads a declared target path written with a leading ./", async () => {
    // `cargo metadata` reports the binary at `src/tools/tool.rs`, and `cargo
    // build` compiles against `src/tools/part.rs` — a `compile_error!` in the
    // deeper file proves the deeper one is never read. Left unnormalized, the
    // manifest string matched nothing, the declaration was dropped, and
    // convention rooted the file one directory too deep.
    const graph = await graphOf({
      "Cargo.toml": '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n\n[[bin]]\nname = "tool"\npath = "./src/tools/tool.rs"\n',
      "src/tools/tool.rs": "mod part;\n\nfn main() { part::x(); }",
      "src/tools/part.rs": "pub fn x() {}",
      "src/tools/tool/part.rs": 'compile_error!("wrong file");',
    });

    expect(graph.edges.some((e) => e.source === "src/tools/tool.rs" && e.target === "src/tools/part.rs")).toBe(true);
    expect(graph.edges.some((e) => e.target === "src/tools/tool/part.rs")).toBe(false);
  });

  it("draws no 2015 edge to a module the crate never declares", async () => {
    // `use ghost::f;` with `src/ghost.rs` present but declared nowhere is
    // `error[E0432]: unresolved import 'ghost'` on cargo 1.98.0. The
    // root-relative reading of edition 2015 needs no declaration in the
    // importing file, but it still needs one somewhere in the crate; matching a
    // sibling file by name is a filesystem answer to a question about the
    // module tree.
    const graph = await graphOf({
      "Cargo.toml": '[package]\nname = "app"\nversion = "0.1.0"\n',
      "src/lib.rs": "pub mod client;",
      "src/client.rs": "use ghost::f;\n\npub fn u() { f(); }",
      "src/ghost.rs": "pub fn f() {}",
    });

    expect(graph.edges.some((e) => e.target === "src/ghost.rs")).toBe(false);
    expect(graph.edges.some((e) => e.source === "src/lib.rs" && e.target === "src/client.rs")).toBe(true);
  });

  it("names the cost of the gate: one real 2015 edge left undrawn", async () => {
    // `use foo::AtRoot;` in `src/deep/mod.rs` compiles with `mod foo;` written
    // in `lib.rs` and nothing in the importing file — checked on cargo 1.98.0.
    // The edge is real and stays undrawn, which is the price of resolving only
    // what a declaration proves. It is a price and not a regression: `main`
    // does not draw it either. Should this ever need closing, it takes the
    // crate's declarations gathered from an AST, and every one of the wrong
    // edges listed in `graph-resolution.ts` has to stay closed with it.
    const graph = await graphOf({
      "Cargo.toml": '[package]\nname = "app"\nversion = "0.1.0"\n',
      "src/lib.rs": "mod deep;\nmod foo;",
      "src/foo.rs": "pub struct AtRoot;",
      "src/deep/mod.rs": "use foo::AtRoot;\n\npub fn take() -> AtRoot { AtRoot }",
    });

    expect(graph.edges.some((e) => e.source === "src/deep/mod.rs" && e.target === "src/foo.rs")).toBe(false);
    // The declarations themselves still draw theirs.
    expect(graph.edges.some((e) => e.source === "src/lib.rs" && e.target === "src/foo.rs")).toBe(true);
  });

  it("names the cost of the gate: the root-relative path is lost through #[path] too", async () => {
    // The same price, one step further from the simple case: in 2015 the head
    // counts from the crate root whatever put the module there, so a `#[path]`
    // relocation is as good a declaration as a plain `mod`. `use foo::AtRoot;`
    // in `src/deep/mod.rs` compiles against `src/custom/thing.rs` — checked on
    // cargo 1.98.0, where renaming the struct in that file is the one token
    // that flips the build.
    //
    // Written only as the simple case, the test said the gate cost less than
    // it does: whoever weighs closing it has to see every shape of the loss.
    const graph = await graphOf({
      "Cargo.toml": '[package]\nname = "path2015"\nversion = "0.1.0"\nedition = "2015"\n',
      "src/lib.rs": '#[path = "custom/thing.rs"]\npub mod foo;\npub mod deep;\n',
      "src/custom/thing.rs": "pub struct AtRoot;",
      "src/deep/mod.rs": "use foo::AtRoot;\n\npub fn take() -> AtRoot { AtRoot }",
    });

    expect(
      graph.edges.some((e) => e.source === "src/deep/mod.rs" && e.target === "src/custom/thing.rs"),
    ).toBe(false);
    // The relocation itself still draws its edge.
    expect(graph.edges.some((e) => e.source === "src/lib.rs" && e.target === "src/custom/thing.rs")).toBe(
      true,
    );
  });

  it("names the cost of the gate: it applies under a manifest-declared root", async () => {
    // The crate root is wherever the manifest says, and in 2015 an unanchored
    // head counts from there. `use helper::AtRoot;` in `src/tools/deep.rs`
    // compiles against `src/tools/helper.rs`, declared in the `[[bin]]` root
    // beside it — checked on cargo 1.98.0. The gate drops this one as well.
    const graph = await graphOf({
      "Cargo.toml": [
        '[package]\nname = "bin2015"\nversion = "0.1.0"\nedition = "2015"\n',
        '[[bin]]\nname = "tool"\npath = "src/tools/tool.rs"\n',
      ].join("\n"),
      "src/tools/tool.rs": "mod helper;\nmod deep;\n\nfn main() { let _ = deep::take(); }",
      "src/tools/helper.rs": "pub struct AtRoot;",
      "src/tools/deep.rs": "use helper::AtRoot;\n\npub fn take() -> AtRoot { AtRoot }",
    });

    expect(graph.edges.some((e) => e.source === "src/tools/deep.rs" && e.target === "src/tools/helper.rs")).toBe(
      false,
    );
    // The declared root still reaches both of its modules.
    expect(graph.edges.some((e) => e.source === "src/tools/tool.rs" && e.target === "src/tools/helper.rs")).toBe(
      true,
    );
  });

  it("draws no edge for a single-segment 2015 use between integration tests", async () => {
    // The single-segment spelling of the same rule: `use b;` in `tests/a.rs` is
    // E0432, "no `b` in the root". Guarding only the multi-segment branch left
    // this one drawing the edge.
    const graph = await graphOf({
      "Cargo.toml": '[package]\nname = "app"\nversion = "0.1.0"\n',
      "src/lib.rs": "pub fn n() {}",
      "tests/a.rs": "use b;\n\n#[test]\nfn t() {}",
      "tests/b.rs": "pub fn helper() {}",
    });

    expect(graph.edges.some((e) => e.source === "tests/a.rs" && e.target === "tests/b.rs")).toBe(false);
  });

  it("reads a declared target path that climbs out of the package directory", async () => {
    // `[lib] path = "../bar/src/lib.rs"` is legal and cargo builds it. Joined
    // without normalizing it read `crates/foo/../bar/src/lib.rs`, which the file
    // set never holds, so the declaration was dropped — and with it the crate's
    // name, its roots, and every edge its dependents draw into it.
    const graph = await graphOf({
      "Cargo.toml": '[workspace]\nmembers = ["crates/foo", "crates/bar"]\nresolver = "2"\n',
      "crates/foo/Cargo.toml": '[package]\nname = "foo"\nversion = "0.1.0"\nedition = "2021"\n\n[lib]\npath = "../bar/src/lib.rs"\n',
      "crates/foo/src/main.rs": "use foo::bar_fn;\n\nfn main() { bar_fn(); }",
      "crates/bar/Cargo.toml": '[package]\nname = "bar"\nversion = "0.1.0"\nedition = "2021"\n',
      "crates/bar/src/lib.rs": "pub fn bar_fn() {}",
    });

    expect(
      graph.edges.some((e) => e.source === "crates/foo/src/main.rs" && e.target === "crates/bar/src/lib.rs"),
    ).toBe(true);
  });

  it("reads a declared target path written as an absolute path", async () => {
    // Cargo accepts an absolute `path` and builds it. Joined as if it were
    // relative it produced `crates/foo//Users/…`, matched nothing, and the
    // crate lost its name and roots along with every edge into it. The fixture
    // has to build the absolute path at run time, which is why it is written
    // through a second call rather than as a literal.
    const dir = writeLayout({
      "custom/lib.rs": "pub fn from_lib() {}",
      "src/main.rs": "use app::from_lib;\n\nfn main() { from_lib(); }",
    });
    roots.push(dir);
    fs.writeFileSync(
      path.join(dir, "Cargo.toml"),
      // Forward slashes even on Windows: a backslash in a TOML basic string
      // opens an escape, and `\U` or `\c` out of a drive path is one smol-toml
      // rejects — the manifest would be dropped and the edge with it, which is
      // the very thing this asserts (review finding).
      `[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n\n[lib]\npath = "${path.join(dir, "custom/lib.rs").split(path.sep).join("/")}"\n`,
    );
    const graph = await buildCodeGraph(dir);

    expect(graph.edges.some((e) => e.source === "src/main.rs" && e.target === "custom/lib.rs")).toBe(true);
  });

  it("does not reach a project crate whose name is a registry dependency", async () => {
    // `log = "0.4"` names the registry crate, and a workspace member also
    // called `log` is a different crate that is never in scope. Checked on
    // cargo 1.98.0: the package builds against `log v0.4.34` from the registry
    // with a `compile_error!` sitting in the local one, which proves rustc
    // never reads it — while the graph drew an edge straight into it.
    const graph = await graphOf({
      "Cargo.toml": '[workspace]\nmembers = ["crates/app", "crates/log"]\nresolver = "2"\n',
      "crates/app/Cargo.toml":
        '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nlog = "0.4"\n',
      "crates/app/src/lib.rs": "use log::info;\n\npub fn shout() { info!(\"from the registry\"); }",
      "crates/log/Cargo.toml": '[package]\nname = "log"\nversion = "0.1.0"\nedition = "2021"\n',
      "crates/log/src/lib.rs": 'compile_error!("never in scope for app");',
    });

    expect(graph.edges.some((e) => e.target === "crates/log/src/lib.rs")).toBe(false);
  });

  it("inherits from the workspace that a dependency is a registry one", async () => {
    // `log = { workspace = true }` says nothing about where the crate comes
    // from: the answer is in `[workspace.dependencies]`, and a member that
    // writes it must read the same one cargo reads. Checked on cargo 1.98.0
    // with the local crate holding a `compile_error!`: `cargo check -p app`
    // downloads and builds `log v0.4.34`, and the member is never touched.
    //
    // The workspace entry is a table with a version and no `path` on purpose.
    // Written as the bare string `log = "0.4"` this test passes even on a
    // resolver that inherits nothing, because a string is not a table and never
    // reaches the local branch at all — a shape that proves nothing.
    const graph = await graphOf({
      "Cargo.toml": [
        '[workspace]\nmembers = ["crates/app", "crates/log"]\nresolver = "2"\n',
        '[workspace.dependencies]\nlog = { version = "0.4" }\n',
      ].join("\n"),
      "crates/app/Cargo.toml": [
        '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n',
        "[dependencies]\nlog = { workspace = true }\n",
      ].join("\n"),
      "crates/app/src/lib.rs": 'use log::info;\n\npub fn shout() { info!("from the registry"); }',
      "crates/log/Cargo.toml": '[package]\nname = "log"\nversion = "0.1.0"\nedition = "2021"\n',
      "crates/log/src/lib.rs": 'compile_error!("never in scope for app");',
    });

    // The absence is the assertion, so the file that would draw the edge has to
    // be in the graph for the absence to mean anything: a walk that never
    // reached it would satisfy the line below just as well.
    expect(graph.nodes.some((n) => n.relativePath === "crates/app/src/lib.rs")).toBe(true);
    expect(graph.edges.some((e) => e.target === "crates/log/src/lib.rs")).toBe(false);
  });

  it("inherits from the workspace that a dependency is a local one", async () => {
    // The other half, and the token that flips rustc: the same two manifests
    // with `"0.4"` replaced by `{ path = "crates/log" }` in the workspace
    // table. Cargo then compiles the member — it is how the `compile_error!`
    // above was shown to be reachable at all — so the edge has to be drawn.
    // Without this half the test above passes on a resolver that calls every
    // inherited dependency external.
    const graph = await graphOf({
      "Cargo.toml": [
        '[workspace]\nmembers = ["crates/app", "crates/log"]\nresolver = "2"\n',
        '[workspace.dependencies]\nlog = { path = "crates/log" }\n',
      ].join("\n"),
      "crates/app/Cargo.toml": [
        '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n',
        "[dependencies]\nlog = { workspace = true }\n",
      ].join("\n"),
      "crates/app/src/lib.rs": "use log::marker;\n\npub fn go() -> marker::Local { marker::Local }",
      "crates/log/Cargo.toml": '[package]\nname = "log"\nversion = "0.1.0"\nedition = "2021"\n',
      "crates/log/src/lib.rs": "pub mod marker { pub struct Local; }",
    });

    expect(
      graph.edges.some((e) => e.source === "crates/app/src/lib.rs" && e.target === "crates/log/src/lib.rs"),
    ).toBe(true);
  });

  it("inherits nothing where the member declares the dependency itself", async () => {
    // A member that writes its own entry inherits nothing, even where the
    // workspace happens to declare the same name with a `path`. Checked on
    // cargo 1.98.0 with a `compile_error!` in the member: `cargo check -p app`
    // builds `log v0.4.34` from the registry and stays clean.
    //
    // Without the `workspace === true` guard on the inherited answer, the
    // workspace's entry would decide for a member that never asked — and the
    // whole point of reading the manifest is that a dependency with no `path`
    // is a different crate, whatever the project holds under that name.
    const graph = await graphOf({
      "Cargo.toml": [
        '[workspace]\nmembers = ["crates/app", "crates/log"]\nresolver = "2"\n',
        '[workspace.dependencies]\nlog = { path = "crates/log" }\n',
      ].join("\n"),
      "crates/app/Cargo.toml": [
        '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n',
        '[dependencies]\nlog = { version = "0.4" }\n',
      ].join("\n"),
      "crates/app/src/lib.rs": 'use log::info;\n\npub fn shout() { info!("from the registry"); }',
      "crates/log/Cargo.toml": '[package]\nname = "log"\nversion = "0.1.0"\nedition = "2021"\n',
      "crates/log/src/lib.rs": 'compile_error!("never in scope for app");',
    });

    expect(graph.nodes.some((n) => n.relativePath === "crates/app/src/lib.rs")).toBe(true);
    expect(graph.edges.some((e) => e.target === "crates/log/src/lib.rs")).toBe(false);
  });

  it("inherits a dash-named dependency under the name the source writes", async () => {
    // Cargo turns dashes into underscores for the importable name, so the
    // manifest says `my-log` and the source says `my_log`. Both sides of the
    // inheritance normalise, and nothing proved they normalise the same way:
    // looking the workspace's answer up under the raw manifest key instead of
    // the normalised one silently drops the edge, and every other test here
    // uses a name with no dash, where the two spellings coincide.
    //
    // Checked on cargo 1.98.0: `cargo check -p app` compiles the member
    // `my-log v0.1.0` and then `app`, which imports it as `my_log`.
    const graph = await graphOf({
      "Cargo.toml": [
        '[workspace]\nmembers = ["crates/app", "crates/my-log"]\nresolver = "2"\n',
        '[workspace.dependencies]\nmy-log = { path = "crates/my-log" }\n',
      ].join("\n"),
      "crates/app/Cargo.toml": [
        '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n',
        "[dependencies]\nmy-log = { workspace = true }\n",
      ].join("\n"),
      "crates/app/src/lib.rs": "use my_log::marker;\n\npub fn go() -> marker::Local { marker::Local }",
      "crates/my-log/Cargo.toml": '[package]\nname = "my-log"\nversion = "0.1.0"\nedition = "2021"\n',
      "crates/my-log/src/lib.rs": "pub mod marker { pub struct Local; }",
    });

    expect(
      graph.edges.some(
        (e) => e.source === "crates/app/src/lib.rs" && e.target === "crates/my-log/src/lib.rs",
      ),
    ).toBe(true);
  });

  it("reaches a project crate a [patch] sends a registry name to", async () => {
    // The same manifest, one section added, and cargo changes its answer with
    // the graph: `[patch.crates-io] log = { path = … }` builds `log v0.4.34`
    // from the member. It is how a workspace makes its members depend on each
    // other by version — tokio patches all five of its crates that way, and
    // reading the names as registry ones cost 473 real edges there.
    const graph = await graphOf({
      "Cargo.toml": [
        '[workspace]\nmembers = ["crates/app", "crates/log"]\nresolver = "2"\n',
        '[patch.crates-io]\nlog = { path = "crates/log" }\n',
      ].join("\n"),
      "crates/app/Cargo.toml":
        '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nlog = "0.4"\n',
      "crates/app/src/lib.rs": "use log::marker;\n\npub fn shout() -> marker::Local { marker::Local }",
      "crates/log/Cargo.toml": '[package]\nname = "log"\nversion = "0.4.34"\nedition = "2021"\n',
      "crates/log/src/lib.rs": "pub mod marker { pub struct Local; }",
    });

    expect(
      graph.edges.some((e) => e.source === "crates/app/src/lib.rs" && e.target === "crates/log/src/lib.rs"),
    ).toBe(true);
  });

  it("reaches a project crate a [replace] sends a registry name to", async () => {
    // `[replace]` is the older spelling of the same redirection, keyed by name
    // and version instead of by source. Cargo still honours it, so the graph
    // reads it too — and nothing proved that until now: deleting the line that
    // reads it left all 1313 proofs green.
    const graph = await graphOf({
      "Cargo.toml": [
        '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n',
        '[dependencies]\nlog = "0.4.34"\n',
        '[replace]\n"log:0.4.34" = { path = "local-log" }\n',
      ].join("\n"),
      "src/lib.rs": "use log::marker;\n\npub fn go() -> marker::Local { marker::Local }",
      "local-log/Cargo.toml": '[package]\nname = "log"\nversion = "0.4.34"\nedition = "2021"\n',
      "local-log/src/lib.rs": "pub mod marker { pub struct Local; }",
    });

    expect(
      graph.edges.some((e) => e.source === "src/lib.rs" && e.target === "local-log/src/lib.rs"),
    ).toBe(true);
  });

  it("does not fall through to a crate when the declared module's file is missing", async () => {
    // The gate that stops a declaration from becoming an edge into a library of
    // the same name. `mod log;` says `log` is this file's module, whatever the
    // manifest carries — so if its file cannot be found, the answer is nothing,
    // not the crate. rustc agrees loudly: a `#[path]` at a file that does not
    // exist is E0583, and the build never reaches the dependency.
    //
    // Nothing held this: removing the gate left the battery green, and the edge
    // it draws is the exact shape #118 exists to close — a plausible file in
    // the project captured by a name that belongs to a dependency.
    const graph = await graphOf({
      "Cargo.toml": '[workspace]\nmembers = ["crates/app", "crates/log"]\nresolver = "2"\n',
      "crates/app/Cargo.toml":
        '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nlog = { path = "../log" }\n',
      // The declaration names a file that is not there, so the module has no
      // file at all — and `use log::marker;` below must reach neither.
      // A single-segment `use`, because that is the shape the gate answers: a
      // longer path is resolved by walking the module tree and never reaches
      // the crate fallback at all.
      "crates/app/src/lib.rs": '#[path = "nowhere.rs"]\nmod log;\n\nuse log;\n\npub fn go() -> u32 { 1 }',
      "crates/log/Cargo.toml": '[package]\nname = "log"\nversion = "0.1.0"\nedition = "2021"\n',
      "crates/log/src/lib.rs": "pub mod marker { pub struct Local; }",
    });

    // The crate's file is in the graph, so the absence is about the gate and
    // not about a target that was never there.
    expect(graph.nodes.some((n) => n.relativePath === "crates/log/src/lib.rs")).toBe(true);
    expect(
      graph.edges.some(
        (e) => e.source === "crates/app/src/lib.rs" && e.target === "crates/log/src/lib.rs",
      ),
    ).toBe(false);
  });

  it("reaches the file a literal include! pastes in", async () => {
    // `include!` is in the Reference like the `#[path]` this resolver already
    // reads, so it passes the admission rule in `graph-imports.ts`: the
    // language guarantees it, and knowing no library is required. Verified on
    // cargo 1.98.0 — `gen.rs` is in the lib's dep-info, and a `compile_error!`
    // placed in it fails the build, so rustc genuinely reads it.
    //
    // It declares no module: `gen.rs` brings no name into scope, and `use
    // gen::…` beside it is E0432. What it leaves is an edge, and nothing else.
    const graph = await graphOf({
      "Cargo.toml": '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n',
      "src/lib.rs": 'include!("gen.rs");\n\npub fn go() -> u32 { generated() }\n',
      "src/gen.rs": "fn generated() -> u32 { 1 }\n",
    });

    expect(graph.edges.some((e) => e.source === "src/lib.rs" && e.target === "src/gen.rs")).toBe(true);
  });

  it("counts an include! from the writing file even inside an inline module", async () => {
    // The half a `#[path]` does differently, and the reason this is its own
    // test: a `#[path]` written inside `mod inner { … }` files its target under
    // `inner/`, an `include!` does not — it pastes text, and the Reference
    // counts its path from the directory of the file that writes it whatever it
    // is nested in. Reading it like a `#[path]` would look for `src/inner/gen.rs`
    // and find nothing.
    const graph = await graphOf({
      "Cargo.toml": '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n',
      "src/lib.rs": 'pub mod inner {\n    include!("gen.rs");\n}\n',
      "src/gen.rs": "pub fn generated() -> u32 { 1 }\n",
      // The file the other reading would reach. It exists, so the assertion
      // below fails rather than passes if the base directory ever changes.
      "src/inner/gen.rs": "pub fn wrong() -> u32 { 2 }\n",
    });

    expect(graph.edges.some((e) => e.source === "src/lib.rs" && e.target === "src/gen.rs")).toBe(true);
    expect(graph.edges.some((e) => e.source === "src/lib.rs" && e.target === "src/inner/gen.rs")).toBe(false);
  });

  it("draws no edge for an include! whose path is built at build time", async () => {
    // `concat!(env!("OUT_DIR"), …)` names a file that does not exist until
    // `build.rs` has run, so there is nothing in the tree to point at and
    // guessing one would be an edge rustc never draws. The admission rule
    // refuses it for that reason and not for effort.
    //
    // The decoy is the point: a file named exactly as the concatenation would
    // suggest sits in the tree, so a resolver that started stitching the pieces
    // together would find it and this test would fail.
    const graph = await graphOf({
      "Cargo.toml": '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n',
      "src/lib.rs": 'include!(concat!(env!("OUT_DIR"), "/generated.rs"));\n',
      "src/generated.rs": "pub fn decoy() -> u32 { 1 }\n",
    });

    expect(graph.edges.some((e) => e.source === "src/lib.rs" && e.target === "src/generated.rs")).toBe(
      false,
    );
  });

  it("does not read an include! written inside a doc comment", async () => {
    // Nine of these sit in a 1,256-crate registry cache: a doc example showing
    // how to use the macro, with a path that is illustrative and often names no
    // file at all. It is the same trap a `path` written in a doc string is, and
    // reading the AST rather than the text is what keeps it out — the text of a
    // comment is never a `macro_invocation` node.
    const graph = await graphOf({
      "Cargo.toml": '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n',
      "src/lib.rs":
        '//! Example:\n//!\n//! ```\n//! include!("illustrative.rs");\n//! ```\n\npub fn go() -> u32 { 1 }\n',
      // The file exists, so an implementation reading the raw text would find
      // it and draw the edge: the absence below is about the reading, not about
      // a missing target.
      "src/illustrative.rs": "pub fn shown() -> u32 { 2 }\n",
    });

    expect(graph.nodes.some((n) => n.relativePath === "src/illustrative.rs")).toBe(true);
    expect(graph.edges.some((e) => e.source === "src/lib.rs" && e.target === "src/illustrative.rs")).toBe(
      false,
    );
  });

  it("draws no edge for a module a third-party macro generates", async () => {
    // Not a gap left open by accident: it is the admission rule in
    // `graph-imports.ts` refusing a case, and this test is what stops the
    // boundary from moving quietly.
    //
    // `automod::dir!("tests/builder")` generates one `mod` per file in that
    // directory, and the declarations are nowhere in the source. Reading it
    // means teaching the resolver one third-party macro *and* its expansion
    // rules — where the path counts from, whether it recurses, which names are
    // excluded — and once that is in, the criterion is no longer "what the
    // source says" but "which libraries we happen to know".
    //
    // If a future change makes this pass, that is a decision to take on
    // purpose, in the open, with the rule above rewritten — not a green tick.
    const graph = await graphOf({
      "Cargo.toml": '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n',
      // The written `mod` is the control: same file, same directory level, one
      // declaration spelled out and one generated. Without it an assertion of
      // absence proves nothing — a resolver that drew no edge at all here, for
      // any reason, would satisfy it just as well.
      "tests/main.rs": 'mod written;\n\nautomod::dir!("tests/cases");\n',
      "tests/written.rs": "#[test]\nfn written() {}\n",
      "tests/cases/alpha.rs": "#[test]\nfn alpha() {}\n",
      "tests/cases/beta.rs": "#[test]\nfn beta() {}\n",
    });

    expect(
      graph.edges.some((e) => e.source === "tests/main.rs" && e.target === "tests/written.rs"),
    ).toBe(true);

    // The generated ones are nodes — they are Rust source and the walk finds
    // them — so what is missing below is the edge, not the files.
    expect(graph.nodes.some((n) => n.relativePath === "tests/cases/alpha.rs")).toBe(true);
    expect(graph.nodes.some((n) => n.relativePath === "tests/cases/beta.rs")).toBe(true);
    expect(graph.edges.some((e) => e.source === "tests/main.rs" && e.target.startsWith("tests/cases/"))).toBe(
      false,
    );
  });

  it("ignores a [patch] aimed at a git remote rather than at the registry", async () => {
    // `[patch]` is keyed by the source it redirects, and only the entry under
    // `crates-io` touches a dependency written as a version. A section keyed by
    // a git URL redirects *that* remote, so a `log = "0.4"` taken from the
    // registry is untouched by it and cargo keeps building the registry crate —
    // verified on 1.98.0, where the dep-info names neither the local directory
    // nor anything under it.
    //
    // The same manifest with `crates-io` in place of the URL is the gemello
    // above, which does draw the edge: one token apart, opposite answers.
    // Nothing proved this half — removing the line that checks the source left
    // the whole battery green.
    const graph = await graphOf({
      "Cargo.toml": [
        '[workspace]\nmembers = ["crates/app", "crates/log"]\nresolver = "2"\n',
        '[patch."https://github.com/rust-lang/log"]\nlog = { path = "crates/log" }\n',
      ].join("\n"),
      "crates/app/Cargo.toml":
        '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nlog = "0.4"\n',
      "crates/app/src/lib.rs": "use log::marker;\n\npub fn shout() -> marker::Local { marker::Local }",
      "crates/log/Cargo.toml": '[package]\nname = "log"\nversion = "0.4.34"\nedition = "2021"\n',
      "crates/log/src/lib.rs": "pub mod marker { pub struct Local; }",
    });

    // The file the edge would land on has to be in the graph, or a broken graph
    // satisfies this assertion by drawing nothing at all.
    expect(graph.nodes.some((n) => n.relativePath === "crates/log/src/lib.rs")).toBe(true);
    expect(
      graph.edges.some((e) => e.source === "crates/app/src/lib.rs" && e.target === "crates/log/src/lib.rs"),
    ).toBe(false);
  });

  it("ignores a [patch] a workspace member declares for itself", async () => {
    // Cargo says so out loud — "patch for the non root package will be ignored,
    // specify patch at the workspace root" — and then fails the build with
    // `error[E0432]: unresolved import 'log::marker'`, which is the proof that
    // it compiled against the registry crate. Honouring the member's patch drew
    // an edge into a crate the build never touches.
    const graph = await graphOf({
      "Cargo.toml": '[workspace]\nmembers = ["crates/app", "crates/log"]\nresolver = "2"\n',
      "crates/app/Cargo.toml": [
        '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n',
        '[dependencies]\nlog = "0.4"\n',
        '[patch.crates-io]\nlog = { path = "../log" }\n',
      ].join("\n"),
      "crates/app/src/lib.rs": "use log::marker;\n\npub fn go() -> marker::Local { marker::Local }",
      "crates/log/Cargo.toml": '[package]\nname = "log"\nversion = "0.4.34"\nedition = "2021"\n',
      "crates/log/src/lib.rs": "pub mod marker { pub struct Local; }",
    });

    expect(graph.edges.some((e) => e.target === "crates/log/src/lib.rs")).toBe(false);
  });

  it("matches a [patch] by package name, not by the alias it is imported as", async () => {
    // `alias = { package = "itoa" }` is patched under `itoa` and written as
    // `alias`. Matching the two directly left the alias among the external
    // names and dropped the edge, though cargo 1.98.0 builds
    // `itoa v1.0.18 (crates/itoa)` from the member.
    const graph = await graphOf({
      "Cargo.toml": [
        '[workspace]\nmembers = ["crates/app", "crates/itoa"]\nresolver = "2"\n',
        '[patch.crates-io]\nitoa = { path = "crates/itoa" }\n',
      ].join("\n"),
      "crates/app/Cargo.toml": [
        '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n',
        '[dependencies]\nalias = { package = "itoa", version = "1.0" }\n',
      ].join("\n"),
      "crates/app/src/lib.rs": "use alias::marker;\n\npub fn go() -> marker::Local { marker::Local }",
      "crates/itoa/Cargo.toml": '[package]\nname = "itoa"\nversion = "1.0.18"\nedition = "2021"\n',
      "crates/itoa/src/lib.rs": "pub mod marker { pub struct Local; }",
    });

    expect(
      graph.edges.some((e) => e.source === "crates/app/src/lib.rs" && e.target === "crates/itoa/src/lib.rs"),
    ).toBe(true);
  });

  it("does not let a crates-io patch capture a git dependency", async () => {
    // `[patch.crates-io]` patches that registry and nothing else. Cargo 1.98.0
    // keeps fetching the git checkout — its dep-info names the clone under
    // `CARGO_HOME/git` — and the local crate, carrying a `compile_error!`, is
    // never read, which is what lets the build finish.
    const graph = await graphOf({
      "Cargo.toml": [
        '[workspace]\nmembers = ["crates/app", "crates/itoa"]\nresolver = "2"\n',
        '[patch.crates-io]\nitoa = { path = "crates/itoa" }\n',
      ].join("\n"),
      "crates/app/Cargo.toml": [
        '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n',
        '[dependencies]\nitoa = { git = "https://example.invalid/itoa" }\n',
      ].join("\n"),
      "crates/app/src/lib.rs": "use itoa::marker;\n\npub fn go() -> marker::Remote { marker::Remote }",
      "crates/itoa/Cargo.toml": '[package]\nname = "itoa"\nversion = "1.0.18"\nedition = "2021"\n',
      "crates/itoa/src/lib.rs": 'compile_error!("a crates-io patch does not touch a git dependency");',
    });

    expect(graph.edges.some((e) => e.target === "crates/itoa/src/lib.rs")).toBe(false);
  });

  it("reaches a project crate declared by path under the same name", async () => {
    // The other half of the rule: a `path` dependency is the project's own
    // crate whatever else carries that name on a registry.
    const graph = await graphOf({
      "Cargo.toml": '[workspace]\nmembers = ["crates/app", "crates/log"]\nresolver = "2"\n',
      "crates/app/Cargo.toml": [
        '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n',
        '[dependencies]\nlog = { path = "../log" }\n',
      ].join("\n"),
      "crates/app/src/lib.rs": "use log::marker;\n\npub fn shout() -> marker::Local { marker::Local }",
      "crates/log/Cargo.toml": '[package]\nname = "log"\nversion = "0.1.0"\nedition = "2021"\n',
      "crates/log/src/lib.rs": "pub mod marker { pub struct Local; }",
    });

    expect(
      graph.edges.some((e) => e.source === "crates/app/src/lib.rs" && e.target === "crates/log/src/lib.rs"),
    ).toBe(true);
  });

  it("draws the edge of a module declared inside a macro body", async () => {
    // Checked on cargo 1.98.0: the package builds and its dep-info lists
    // `src/hidden.rs`, which nothing but the macro body declares. Left
    // unparsed, that file had no incoming edge at all — the shape behind 77 of
    // tokio's false orphans, where `cfg_io_util! { mod … }` hides 36
    // declarations in one block.
    const graph = await graphOf({
      "Cargo.toml": '[package]\nname = "macromod"\nversion = "0.1.0"\nedition = "2021"\n',
      "src/lib.rs": [
        "macro_rules! cfg_thing {",
        "    ($($item:item)*) => { $($item)* };",
        "}",
        "",
        "cfg_thing! {",
        "    mod hidden;",
        "    pub use hidden::Thing;",
        "}",
        "",
        "pub fn make() -> Thing { Thing }",
      ].join("\n"),
      "src/hidden.rs": "pub struct Thing;",
    });

    expect(graph.edges.some((e) => e.source === "src/lib.rs" && e.target === "src/hidden.rs")).toBe(true);
  });

  it("keeps a macro body inside the module block that encloses it", async () => {
    // The body is unwrapped where it stands, so the enclosing `mod inner { … }`
    // still counts and the macro adds no level: the file is `src/inner/deep.rs`.
    // Reading the body as a scope of its own would have looked one directory
    // too far down.
    const graph = await graphOf({
      "Cargo.toml": '[package]\nname = "macroscope"\nversion = "0.1.0"\nedition = "2021"\n',
      "src/lib.rs": [
        "macro_rules! cfg_thing {",
        "    ($($item:item)*) => { $($item)* };",
        "}",
        "",
        "pub mod inner {",
        "    cfg_thing! {",
        "        pub mod deep;",
        "    }",
        "}",
      ].join("\n"),
      "src/inner/deep.rs": "pub struct Deep;",
    });

    expect(graph.edges.some((e) => e.source === "src/lib.rs" && e.target === "src/inner/deep.rs")).toBe(
      true,
    );
  });

  it("draws every file a conditional path attribute can select", async () => {
    // Checked on cargo 1.98.0: the package builds on unix and its dep-info
    // lists `src/lib.rs` and `src/unix.rs`. Read as if the attribute were not
    // there, the graph got both halves wrong at once — an edge to the file the
    // name alone implies, and none to the one holding the module's whole body.
    //
    // The convention is drawn too, and that is not a leftover: a `cfg_attr`
    // applies only where its condition holds, and where none does the module is
    // the file its name implies. `errno` writes exactly this shape, and its
    // `src/sys.rs` says so in its own first line — "a default sys.rs for
    // unrecognized targets… if lib.rs doesn't recognize the target, it defaults
    // to using this file".
    const graph = await graphOf({
      "Cargo.toml": '[package]\nname = "cfgattr"\nversion = "0.1.0"\nedition = "2021"\n',
      "src/lib.rs": [
        '#[cfg_attr(unix, path = "unix.rs")]',
        '#[cfg_attr(windows, path = "windows.rs")]',
        "mod sys;",
        "",
        "pub fn errno() -> i32 { sys::errno() }",
      ].join("\n"),
      "src/unix.rs": "pub fn errno() -> i32 { 0 }",
      "src/windows.rs": "pub fn errno() -> i32 { 1 }",
      "src/sys.rs": 'compile_error!("unsupported target");',
    });

    expect(graph.edges.some((e) => e.source === "src/lib.rs" && e.target === "src/unix.rs")).toBe(true);
    // All three, because the graph fixes no target: the module is one file
    // here, another there, and the fallback where neither condition holds.
    expect(graph.edges.some((e) => e.source === "src/lib.rs" && e.target === "src/windows.rs")).toBe(true);
    expect(graph.edges.some((e) => e.source === "src/lib.rs" && e.target === "src/sys.rs")).toBe(true);
  });

  it("keeps the convention when a conditional path names a file instead", async () => {
    // With the condition false the attribute is not applied at all:
    // `#[cfg_attr(any(), path = "ghost.rs")] mod platform;` compiles against
    // `src/platform.rs` on cargo 1.98.0, whose dep-info names it and not
    // `ghost.rs`. Reading only the named path lost that edge outright.
    const graph = await graphOf({
      "Cargo.toml": '[package]\nname = "cfgfalse"\nversion = "0.1.0"\nedition = "2021"\n',
      "src/lib.rs": [
        '#[cfg_attr(any(), path = "ghost.rs")]',
        "mod platform;",
        "",
        "pub fn go() -> platform::Marker { platform::Marker }",
      ].join("\n"),
      "src/platform.rs": "pub struct Marker;",
      "src/ghost.rs": "pub struct Marker;",
    });

    expect(graph.edges.some((e) => e.source === "src/lib.rs" && e.target === "src/platform.rs")).toBe(true);
  });

  it("keeps the convention for an unconditional path attribute out of it", async () => {
    // The other side: a bare `#[path]` always applies, so the file its name
    // implies is never read and must draw nothing — even when it exists.
    const graph = await graphOf({
      "Cargo.toml": '[package]\nname = "barepath"\nversion = "0.1.0"\nedition = "2021"\n',
      "src/lib.rs": '#[path = "moved.rs"]\nmod platform;\n\npub fn go() -> platform::Marker { platform::Marker }',
      "src/moved.rs": "pub struct Marker;",
      "src/platform.rs": 'compile_error!("never read: the attribute always applies");',
    });

    expect(graph.edges.some((e) => e.source === "src/lib.rs" && e.target === "src/moved.rs")).toBe(true);
    expect(graph.edges.some((e) => e.target === "src/platform.rs")).toBe(false);
  });

  it("does not read a path named inside a doc string as a relocation", async () => {
    // `#[cfg_attr(docsrs, doc = r#"… path = "custom.rs" …"#)] mod plain;`
    // compiles by convention against `src/plain.rs` on cargo 1.98.0, and its
    // dep-info never names `custom.rs`. Scanning the attribute's raw text read
    // the doc's own words as a relocation.
    //
    // `src/custom.rs` is in the fixture so the assertion can fail: without a
    // file there the invented path resolves to nothing and the mistake leaves
    // no trace in the edges.
    const graph = await graphOf({
      "Cargo.toml": '[package]\nname = "docpath"\nversion = "0.1.0"\nedition = "2021"\n',
      "src/lib.rs": [
        '#[cfg_attr(docsrs, doc = r#"override with path = "custom.rs" if needed"#)]',
        "mod plain;",
        "",
        "pub fn go() { plain::hi(); }",
      ].join("\n"),
      "src/plain.rs": "pub fn hi() {}",
      "src/custom.rs": 'compile_error!("named only inside a doc string");',
    });

    expect(graph.edges.some((e) => e.source === "src/lib.rs" && e.target === "src/plain.rs")).toBe(true);
    expect(graph.edges.some((e) => e.target === "src/custom.rs")).toBe(false);
  });

  it("falls back to convention for an empty declared target path", async () => {
    // `path = ""` names no file, and cargo refuses the manifest outright:
    // "path `…/` for lib `emptylib` is a directory, but a source file was
    // expected", the same for a `[[bin]]`. There is no build to mirror, so
    // there is no right answer to read off the oracle — only a choice between
    // two wrong ones.
    //
    // Convention is the cheaper wrong: dropping the target instead would take
    // the crate's name and roots with it, and every edge its dependents draw
    // into it — the regression a `[lib] path = "../…"` already caused once.
    // The declaration is treated as absent, which is what an empty string
    // effectively says, and the tree still reads.
    const graph = await graphOf({
      "Cargo.toml": '[package]\nname = "emptylib"\nversion = "0.1.0"\nedition = "2021"\n\n[lib]\npath = ""\n',
      "src/lib.rs": "pub mod part;",
      "src/part.rs": "pub fn run() {}",
    });

    expect(graph.edges.some((e) => e.source === "src/lib.rs" && e.target === "src/part.rs")).toBe(true);
  });

  it("keeps the inline guard on for a glob over a submodule", async () => {
    // `use crate::prelude::*;` brings in what that module re-exports, not the
    // file's own modules: rustc rejects the `use corelib::marker;` beside it
    // with E0432. Only the anchor itself — `use super::*;` — is the file's
    // scope, so only that one may switch the guard off.
    const graph = await graphOf({
      "Cargo.toml": '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n',
      "src/lib.rs": [
        "pub mod corelib;",
        "pub mod prelude { pub struct Unrelated; }",
        "",
        "pub mod block {",
        "    use crate::prelude::*;",
        "    use corelib::marker;",
        "    pub fn f() -> marker::Marker { marker::Marker }",
        "}",
      ].join("\n"),
      "src/corelib.rs": "pub mod marker { pub struct Marker; }",
    });

    const toCorelib = graph.edges.filter(
      (e) => e.source === "src/lib.rs" && e.target === "src/corelib.rs",
    );
    // Only the one the declaration draws.
    expect(toCorelib).toHaveLength(1);
  });

  it("does not treat a nested block's declaration as the enclosing block's", async () => {
    // `findAll` walks the whole subtree, so `mod corelib` inside `nested`
    // counted as declared by `outer`, and a bare `use corelib::marker;` in
    // `outer` was rebased into the block. rustc 1.98.0 rejects that line with
    // E0432: a name declared in a nested block is in that block's scope only.
    const graph = await graphOf({
      "Cargo.toml": '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n',
      "src/lib.rs": [
        "pub mod outer {",
        "    mod nested { pub mod corelib { pub mod marker { pub struct Marker; } } }",
        "    use corelib::marker;",
        "    pub fn f() -> marker::Marker { marker::Marker }",
        "}",
      ].join("\n"),
      "src/outer/corelib.rs": 'compile_error!("orphan");',
    });

    expect(graph.edges.some((e) => e.target === "src/outer/corelib.rs")).toBe(false);
  });

  it("keeps a block's edge when a glob use puts the name in its scope", async () => {
    // `use super::*;` brings in every module the file declares, and then the
    // bare head does reach one — rustc 1.98.0 resolves it, and rejects the same
    // line with the glob removed. The block's scope is not knowable from the
    // block alone, so nothing is asserted about it.
    //
    // The path reaches a *submodule in its own file*, so the edge it asks for
    // is one the declaration cannot draw. Written against `src/corelib.rs`
    // instead, the assertion was answered by `pub mod corelib;` and held
    // whatever the block did.
    const graph = await graphOf({
      "Cargo.toml": '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n',
      "src/lib.rs": [
        "pub mod corelib;",
        "",
        "pub mod block {",
        "    use super::*;",
        "    use corelib::sub::Marker;",
        "    pub fn f() -> Marker { Marker }",
        "}",
      ].join("\n"),
      "src/corelib/mod.rs": "pub mod sub;",
      "src/corelib/sub.rs": "pub struct Marker;",
    });

    expect(graph.edges.some((e) => e.source === "src/lib.rs" && e.target === "src/corelib/sub.rs")).toBe(true);
  });

  it("reads the anchor glob through a braced group", async () => {
    // `use {super::*};` is the anchor written as a group with no prefix, and
    // `use super::{*};` the same import the other way round. Both compile where
    // the bare head beside them is E0432 without them — checked on cargo
    // 1.98.0. Matching only the flat spelling read neither as an anchor, left
    // the scope guard on, and dropped a real edge.
    for (const anchor of ["use {super::*};", "use super::{*};", "use {super::{*}};"]) {
      const graph = await graphOf({
        "Cargo.toml": '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n',
        "src/lib.rs": [
          "pub mod corelib;",
          "",
          "pub mod block {",
          `    ${anchor}`,
          "    use corelib::sub::Marker;",
          "    pub fn f() -> Marker { Marker }",
          "}",
        ].join("\n"),
        "src/corelib/mod.rs": "pub mod sub;",
        "src/corelib/sub.rs": "pub struct Marker;",
      });

      expect(
        graph.edges.some((e) => e.source === "src/lib.rs" && e.target === "src/corelib/sub.rs"),
        `anchor spelled ${anchor}`,
      ).toBe(true);
    }
  });

  it("keeps the inline guard on for a braced glob over a dependency", async () => {
    // The mirror of the case above, and the reason the group is walked rather
    // than matched on its trailing `*`: `use {std::collections::*};` is a group
    // with no prefix carrying a glob that brings in nothing of this crate.
    // rustc 1.98.0 answers the bare head beside it with E0433, "cannot find
    // module or crate `corelib` in this scope".
    const graph = await graphOf({
      "Cargo.toml": '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n',
      "src/lib.rs": [
        "pub mod corelib;",
        "",
        "pub mod block {",
        "    use {std::collections::*};",
        "    use corelib::sub::Marker;",
        "    pub fn f() -> Marker { Marker }",
        "}",
      ].join("\n"),
      "src/corelib/mod.rs": "pub mod sub;",
      "src/corelib/sub.rs": "pub struct Marker;",
    });

    expect(graph.edges.some((e) => e.source === "src/lib.rs" && e.target === "src/corelib/sub.rs")).toBe(false);
  });

  it("does not let a path inside an inline block reach a module the file declares", async () => {
    // rustc rejects this with `error[E0432]: unresolved import 'corelib'`,
    // "help: a similar path exists: super::corelib::marker" — a declaration at
    // file level is not in the block's scope. The mirror of the case already
    // handled the other way round. The declaration's own edge stays.
    const graph = await graphOf({
      "Cargo.toml": '[package]\nname = "app"\nversion = "0.1.0"\nedition = "2021"\n',
      "src/lib.rs": [
        "pub mod corelib;",
        "",
        "pub mod block {",
        "    use corelib::marker;",
        "    pub fn take() -> marker::Marker { marker::Marker }",
        "}",
      ].join("\n"),
      "src/corelib.rs": "pub mod marker { pub struct Marker; }",
    });

    const toCorelib = graph.edges.filter(
      (e) => e.source === "src/lib.rs" && e.target === "src/corelib.rs",
    );
    // One edge, from `pub mod corelib;`. The `use` inside the block adds none.
    expect(toCorelib).toHaveLength(1);
  });
});
