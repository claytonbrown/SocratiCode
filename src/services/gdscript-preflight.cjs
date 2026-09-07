// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
//
// Isolated preflight for the tree-sitter-gdscript native addon.
// Runs in a child process so that ast-grep's global
// registerDynamicLanguage call does not affect the parent process.
//
// Validates three things that accessSync alone cannot:
//   1. The N-API addon loads (require does not throw).
//   2. It exposes a tree-sitter language object.
//   3. ast-grep can load its `tree_sitter_gdscript` symbol and parse a snippet.
//
// Exit code 0 = all three checks passed.
// Exit code 1 = a check failed (details on stdout).
// Exit code 2 = an unexpected error occurred.

"use strict";

const { createRequire } = require("node:module");
const path = require("node:path");

// Resolve tree-sitter-gdscript's own package.json so we can create a
// require rooted in that package — this avoids relying on npm's hoisted
// node_modules layout (which breaks with --install-strategy=linked).
let treeSitterGdscriptPkg;
try {
  // The parent process passes the resolved package.json path via argv[2].
  const pkgPath = process.argv[2];
  if (pkgPath) {
    treeSitterGdscriptPkg = pkgPath;
  } else {
    // Fallback: resolve from this module's own location (should not
    // normally be needed — the parent always passes the path).
    treeSitterGdscriptPkg = require.resolve("tree-sitter-gdscript/package.json");
  }
} catch (err) {
  console.error("PREFLIGHT: cannot resolve tree-sitter-gdscript/package.json: " + (err && err.message));
  process.exit(2);
}

const pkgRoot = path.dirname(treeSitterGdscriptPkg);

// Create a require rooted at the tree-sitter-gdscript package so that
// node-gyp-build is resolved from its own node_modules, not from the
// root project's hoisted node_modules.
const pkgRequire = createRequire(path.join(pkgRoot, "package.json"));

// Step 1: Resolve the native artifact path via node-gyp-build.
let nativePath;
try {
  const nodeGypBuild = pkgRequire("node-gyp-build");
  nativePath = nodeGypBuild.path(pkgRoot);
} catch (err) {
  console.error("PREFLIGHT: node-gyp-build.path() failed: " + (err && err.message));
  process.exit(1);
}

// Step 2: Load the native addon and check for the required export.
let nativeModule;
try {
  nativeModule = require(nativePath);
} catch (err) {
  console.error("PREFLIGHT: require() of native addon failed: " + (err && err.message));
  process.exit(1);
}

// The N-API addon wraps the C function tree_sitter_gdscript() and exposes
// it as the `language` property. The `languageSymbol` field passed to
// ast-grep's registerDynamicLanguage is the C-level symbol name that
// ast-grep's Rust runtime looks up when it loads the .node file directly —
// it is NOT a JavaScript export name. So we check for the `language`
// export as a basic sanity check, then let the actual ast-grep
// registration + parse be the real validation below.
if (!nativeModule || typeof nativeModule.language !== "object") {
  console.error("PREFLIGHT: native addon does not export a language object");
  process.exit(1);
}

// Step 3: Attempt ast-grep registration and parse in this isolated
// process. If the ABI is incompatible or the grammar is corrupt,
// registerDynamicLanguage or parse will throw.
try {
  // Resolve @ast-grep/napi from the parent project (it is a direct
  // dependency of socraticode, not of tree-sitter-gdscript).
  const { registerDynamicLanguage, parse } = require("@ast-grep/napi");

  registerDynamicLanguage({
    gdscript: {
      libraryPath: nativePath,
      extensions: ["gd"],
      languageSymbol: "tree_sitter_gdscript",
    },
  });

  // Parse a trivial GDScript snippet to verify the grammar works.
  const testSource = "extends Node\n\nfunc _ready():\n    pass\n";
  const root = parse("gdscript", testSource).root();
  const extendsNodes = root.findAll({ rule: { kind: "extends_statement" } });
  if (extendsNodes.length === 0) {
    console.error("PREFLIGHT: parse succeeded but extends_statement not found — grammar may be corrupt");
    process.exit(1);
  }
} catch (err) {
  console.error("PREFLIGHT: ast-grep registration or parse failed: " + (err && err.message));
  process.exit(1);
}

// All checks passed.
console.log("PREFLIGHT: OK " + nativePath);
process.exit(0);
