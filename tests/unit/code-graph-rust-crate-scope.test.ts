// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCodeGraph } from "../../src/services/code-graph.js";
import { resolveCallSites } from "../../src/services/graph-symbol-resolution.js";

/**
 * What `crate::` reaches, through the real `buildCodeGraph` pass.
 *
 * The resolution tests hand `resolveCallSites` a crate map written by hand,
 * which cannot catch a break in the map itself: a boundary drawn from the
 * wrong manifest, or from the path instead of the manifest, passes those tests
 * and produces a graph where `crate::config::load()` names another crate's
 * `config.rs`. So the map gets built here the way a real build builds it.
 *
 * Both fixtures are layouts where a boundary compared as a *prefix* is wrong,
 * because one crate's directory contains another's: a package at the project
 * root beside a crate in `sub/`, and a crate nested inside another crate's
 * tree. `""` and `crates/alpha/` are prefixes of both sides.
 */
describe("Rust crate scope for `crate::`", () => {
  let root: string;

  const write = (rel: string, body: string): void => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  };

  /** Resolve one qualified call written in `callerRel` and return its candidates. */
  async function candidatesOf(
    callerRel: string,
    name = "load",
    qualifier = "crate::config",
  ): Promise<string[]> {
    const graph = await buildCodeGraph(root);
    resolveCallSites(
      graph,
      graph.symbolsByFile,
      graph.outgoingCallsByFile,
      graph.rustBindingsByFile,
      graph.rustCrateRootByFile,
      graph.rustInlineScopedCalls,
      graph.rustInlineDeclaredSymbols,
      graph.rustCrateRootsByFile,
    );
    const edge = (graph.outgoingCallsByFile.get(callerRel) ?? []).find(
      (e) => e.calleeName === name && e.calleeQualifier === qualifier,
    );
    expect(edge, `no qualified call to ${qualifier}::${name} in ${callerRel}`).toBeDefined();
    return (edge?.calleeCandidates ?? []).slice().sort();
  }

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "socraticode-rust-crate-"));

    // ── A package at the project root, with a crate beside it in `sub/` ──
    // The root package's boundary is the whole tree, so a prefix comparison
    // puts `sub/src/config.rs` inside it.
    write("Cargo.toml", '[package]\nname = "rootpkg"\nedition = "2021"\n\n[dependencies]\nsub = { path = "sub" }\n');
    write("src/lib.rs", `pub mod config;
pub mod deep;
use sub::config as subcfg;

pub fn helper() -> u32 { 7 }

pub fn go() -> u32 {
    let _ = subcfg::load();
    crate::config::load()
}
`);
    write("src/config.rs", "pub fn load() -> u32 { 1 }\n");
    // A nested module calling the crate root. `deep/inner.rs` never imports
    // `lib.rs` — the import runs the other way — so `crate::helper()` is only
    // reachable by starting the path where Rust starts it.
    write("src/deep/mod.rs", "pub mod inner;\n");
    write("src/deep/inner.rs", `use crate as root;

pub fn go() -> u32 { crate::helper() }

pub fn go_aliased() -> u32 { root::helper() }
`);
    write("sub/Cargo.toml", '[package]\nname = "sub"\nedition = "2021"\n');
    write("sub/src/lib.rs", "pub mod config;\n");
    write("sub/src/config.rs", "pub fn load() -> u32 { 2 }\n");

    // ── A crate nested inside another crate's directory ──────────────────
    write(
      "crates/alpha/Cargo.toml",
      '[package]\nname = "alpha"\nedition = "2021"\n\n[dependencies]\nbeta = { path = "inner/beta" }\n',
    );
    write("crates/alpha/src/lib.rs", `pub mod config;
pub mod sotto;
use beta::config as bcfg;

pub fn go() -> u32 {
    let _ = bcfg::load();
    crate::config::load()
}

pub fn out_of_the_crate() -> u32 {
    crate::sotto::x::f()
}
`);
    write("crates/alpha/src/config.rs", "pub fn load() -> u32 { 3 }\n");
    // A crate whose directory sits where a module of `alpha` would file its
    // own children: `sotto.rs` belongs to `alpha`, and `sotto/` holds a crate
    // of its own, so `sotto/x.rs` does not. A walk asks the file graph, which
    // has the `mod x;` edge and no notion of a crate boundary, so `alpha`'s
    // `crate::sotto::x` would otherwise land in another crate — which is what
    // the confinement is there to stop, and what nothing exercised.
    write("crates/alpha/src/sotto.rs", "pub mod x;\n");
    write("crates/alpha/src/sotto/Cargo.toml", '[package]\nname = "sotto"\nedition = "2021"\n');
    write("crates/alpha/src/sotto/x.rs", "pub fn f() -> u32 { 9 }\n");
    // ── One directory holding a library and a binary, which is two crates ──
    // `crate::` in `main.rs` is the binary's own root, and answering with the
    // library is a different file. Cargo gives `src/bin/x.rs` a crate too.
    // The three `[[bin]]` entries are targets no convention would find: one
    // inside `src/bin/` with no `main.rs` beside it, two outside it entirely.
    // `cargo metadata` lists all three (cargo 1.98), and nothing but the
    // manifest says so. The resolver must therefore carry the parsed target
    // roots through to `crate::` resolution instead of guessing by filename.
    write(
      "tool/Cargo.toml",
      '[package]\nname = "tool"\nedition = "2021"\n\n[[bin]]\nname = "custom"\npath = "src/bin/custom/helper.rs"\n\n[[bin]]\nname = "launcher"\npath = "launcher/main.rs"\n\n[[bin]]\nname = "flat-launcher"\npath = "launcher.rs"\n',
    );
    write("tool/src/lib.rs", "pub mod shared;\n\npub fn helper() -> u32 { 10 }\n");
    write("tool/src/shared.rs", "pub fn f() -> u32 { 11 }\n");
    write("tool/src/main.rs", `mod cli;

pub fn helper() -> u32 { 12 }

fn main() {
    let _ = crate::helper();
    let _ = cli::run();
}
`);
    write("tool/src/cli.rs", "pub fn run() -> u32 { crate::helper() }\n");
    write("tool/src/bin/x.rs", `pub fn helper() -> u32 { 13 }

fn main() {
    let _ = crate::helper();
}
`);

    // ── A multi-file binary: `src/bin/packer/main.rs` roots it, and every
    // file beside it is one of its modules, however deep. Checked with cargo
    // 1.98: `crate::helper()` in `packer/nested.rs` is the binary's `helper`,
    // and with that one removed the build fails with E0425 rather than falling
    // back to the library's.
    write("tool/src/bin/packer/main.rs", `mod nested;
mod sub;

pub fn helper() -> u32 { 14 }

fn main() {
    let _ = nested::go() + sub::deep::go();
}
`);
    write("tool/src/bin/packer/nested.rs", "pub fn go() -> u32 { crate::helper() }\n");
    write("tool/src/bin/packer/sub/mod.rs", "pub mod deep;\n");
    write("tool/src/bin/packer/sub/deep.rs", "pub fn go() -> u32 { crate::helper() }\n");

    // A `src/bin/` directory with no `main.rs`: a target only because the
    // manifest names the file, which is not readable from the resolver.
    write("tool/src/bin/custom/helper.rs", `mod thing;

pub fn helper() -> u32 { 21 }

fn main() {
    let _ = crate::helper();
    let _ = crate::thing::run();
}
`);
    write("tool/src/bin/custom/thing.rs", "pub fn run() -> u32 { 22 }\n");

    // ── Integration tests, benchmarks and examples: each a crate of its own,
    // and none of them reachable from the library, which never imports its
    // own tests.
    write("tool/tests/it.rs", `pub fn helper() -> u32 { 31 }

#[test]
fn t() {
    let _ = crate::helper();
}
`);
    write("tool/tests/dirtest/main.rs", `mod nested;

pub fn helper() -> u32 { 32 }

#[test]
fn t() {
    let _ = nested::go();
}
`);
    write("tool/tests/dirtest/nested.rs", "pub fn go() -> u32 { crate::helper() }\n");
    // The shared-helper idiom: `tests/common/` holds no `main.rs`, so it is no
    // target, and `crate::` in it means whichever test wrote `mod common;`.
    write("tool/tests/common/mod.rs", "pub fn shared() -> u32 { crate::helper() }\n");
    write("tool/benches/b.rs", `pub fn helper() -> u32 { 41 }

fn main() {
    let _ = crate::helper();
}
`);
    write("tool/examples/e.rs", `pub fn helper() -> u32 { 51 }

fn main() {
    let _ = crate::helper();
}
`);
    // A `[[bin]] path` outside every conventional directory. Only the manifest
    // identifies it as a target root.
    write("tool/launcher/main.rs", `pub fn helper() -> u32 { 61 }

fn main() {
    let _ = crate::helper();
}
`);
    // A custom target whose filename has none of Cargo's conventional root
    // shapes. Before the manifest roots reached resolution, `crate::helper()`
    // here could be answered from `src/lib.rs` instead.
    write("tool/launcher.rs", `pub fn helper() -> u32 { 62 }

fn main() {
    let _ = crate::helper();
}
`);

    // ── A crate whose root module sits where no convention looks ──────────
    // `[lib] path` is the only source of truth for this crate root, just as a
    // custom binary path is for the roots above.
    write("odd/Cargo.toml", '[package]\nname = "odd"\nedition = "2021"\n\n[lib]\npath = "core/root.rs"\n');
    write("odd/core/root.rs", `pub mod config;

pub fn go() -> u32 { crate::config::load() }
`);
    write("odd/core/config.rs", "pub fn load() -> u32 { 91 }\n");

    write("crates/alpha/inner/beta/Cargo.toml", '[package]\nname = "beta"\nedition = "2021"\n');
    write("crates/alpha/inner/beta/src/lib.rs", "pub mod config;\n");
    write("crates/alpha/inner/beta/src/config.rs", "pub fn load() -> u32 { 4 }\n");
  });

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("keeps a root package's `crate::` out of a crate beside it", async () => {
    expect(await candidatesOf("src/lib.rs")).toEqual(["src/config.rs::load#1"]);
  });

  it("reads `crate::` from the crate root, which a nested module never imports", async () => {
    expect(await candidatesOf("src/deep/inner.rs", "helper", "crate")).toEqual([
      "src/lib.rs::helper#5",
    ]);
  });

  it("reads an alias for the crate root the same way", async () => {
    // `use crate as root;` is the same path under another name, so it must
    // reach the same file — not the caller's own scope, which answers nothing.
    expect(await candidatesOf("src/deep/inner.rs", "helper", "root")).toEqual([
      "src/lib.rs::helper#5",
    ]);
  });

  it("reads `crate::` in a binary as the binary's own root", async () => {
    // `tool/src/lib.rs` declares a `helper` too, and is what taking the first
    // root module in the directory answers with — another file, as `unique`.
    expect(await candidatesOf("tool/src/main.rs", "helper", "crate")).toEqual([
      "tool/src/main.rs::helper#3",
    ]);
  });

  it("gives a `src/bin` file a crate root of its own", async () => {
    expect(await candidatesOf("tool/src/bin/x.rs", "helper", "crate")).toEqual([
      "tool/src/bin/x.rs::helper#1",
    ]);
  });

  it("follows the root that reaches the caller when a directory holds two", async () => {
    // `cli.rs` is declared by `main.rs` alone, so `crate::` there is the
    // binary — which the library's own `helper` must not answer.
    expect(await candidatesOf("tool/src/cli.rs", "helper", "crate")).toEqual([
      "tool/src/main.rs::helper#3",
    ]);
  });

  it("reads `crate::` in a binary's nested module as that binary's `main.rs`", async () => {
    // `src/bin/packer/nested.rs` is a module of the `packer` binary, not a
    // crate root of its own. Three files declare `helper` here: the library,
    // the `src/main.rs` binary, and `packer/main.rs` — and only the last one
    // is what rustc reads.
    expect(await candidatesOf("tool/src/bin/packer/nested.rs", "helper", "crate")).toEqual([
      "tool/src/bin/packer/main.rs::helper#4",
    ]);
  });

  it("maps a file nested deeper under a binary to the same `main.rs`", async () => {
    // Cargo autodiscovers `src/bin/<name>/main.rs` and nothing below it, so
    // `packer/sub/deep.rs` belongs to `packer`, not to a `sub` of its own.
    expect(await candidatesOf("tool/src/bin/packer/sub/deep.rs", "helper", "crate")).toEqual([
      "tool/src/bin/packer/main.rs::helper#4",
    ]);
  });

  it("reads `crate::` in an integration test as the test's own root", async () => {
    // A library never imports its own tests, so no root reaches `tests/it.rs`
    // and every root used to be the answer — which collapses onto the library
    // as soon as the library alone declares the name.
    expect(await candidatesOf("tool/tests/it.rs", "helper", "crate")).toEqual([
      "tool/tests/it.rs::helper#1",
    ]);
  });

  it("reads `crate::` in a benchmark as the benchmark's own root", async () => {
    expect(await candidatesOf("tool/benches/b.rs", "helper", "crate")).toEqual([
      "tool/benches/b.rs::helper#1",
    ]);
  });

  it("reads `crate::` in an example as the example's own root", async () => {
    expect(await candidatesOf("tool/examples/e.rs", "helper", "crate")).toEqual([
      "tool/examples/e.rs::helper#1",
    ]);
  });

  it("reads a folder test's module as that test's `main.rs`", async () => {
    expect(await candidatesOf("tool/tests/dirtest/nested.rs", "helper", "crate")).toEqual([
      "tool/tests/dirtest/main.rs::helper#3",
    ]);
  });

  it("uses a manifest-declared file as its own crate root", async () => {
    expect(await candidatesOf("tool/src/bin/custom/helper.rs", "helper", "crate")).toEqual([
      "tool/src/bin/custom/helper.rs::helper#3",
    ]);
  });

  it("walks modules from a manifest-declared crate root", async () => {
    expect(await candidatesOf("tool/src/bin/custom/helper.rs", "run", "crate::thing")).toEqual([
      "tool/src/bin/custom/thing.rs::run#1",
    ]);
  });

  it("leaves a shared `tests/common/mod.rs` unresolved", async () => {
    // No `main.rs` beside it, so `tests/common/` is no target: this file is a
    // module of whichever integration tests write `mod common;`, and `crate::`
    // in it means a different root for each of them.
    expect(await candidatesOf("tool/tests/common/mod.rs", "helper", "crate")).toEqual([]);
  });

  it("uses a custom `main.rs` path as its own crate root", async () => {
    expect(await candidatesOf("tool/launcher/main.rs", "helper", "crate")).toEqual([
      "tool/launcher/main.rs::helper#1",
    ]);
  });

  it("does not send a custom single-file binary's `crate::` to the library", async () => {
    expect(await candidatesOf("tool/launcher.rs", "helper", "crate")).toEqual([
      "tool/launcher.rs::helper#1",
    ]);
  });

  it("uses a manifest-declared library root outside conventional paths", async () => {
    expect(await candidatesOf("odd/core/root.rs")).toEqual(["odd/core/config.rs::load#1"]);
  });

  it("stops a walk at the crate boundary, not only a suffix match", async () => {
    // The file graph records `mod x;` and knows nothing of crates, so the walk
    // reaches `sotto/x.rs` in two honest hops — and that file belongs to the
    // crate whose `Cargo.toml` sits in `sotto/`, not to `alpha`. `crate::`
    // means the caller's own crate, so the answer is nothing.
    expect(await candidatesOf("crates/alpha/src/lib.rs", "f", "crate::sotto::x")).toEqual([]);
  });

  it("keeps a crate's `crate::` out of a crate nested inside its own directory", async () => {
    expect(await candidatesOf("crates/alpha/src/lib.rs")).toEqual([
      "crates/alpha/src/config.rs::load#1",
    ]);
  });
});

/**
 * A module path walked one segment at a time, through the real `buildCodeGraph`
 * pass.
 *
 * The layout is the one that tells a walk from a suffix match: `crate::a::b`
 * and `other::a::b` end in the same two segments, and the caller imports the
 * second. Matching the whole qualifier against the caller's dependencies picks
 * the imported one — the path `crate::a::b` does not name it, and the graph
 * reported it as `unique`.
 *
 * Checked against cargo 1.90.0: the fixture compiles, `crate::a::b::f()`
 * returns 1 (`src/a/b.rs`) and the imported `b::f()` returns 2
 * (`src/other/a/b.rs`), so the two calls in `caller.rs` are two different
 * functions and a test that let them share an answer would be describing a
 * program rustc rejects.
 */
describe("Rust multi-hop module paths", () => {
  let root: string;

  const write = (rel: string, body: string): void => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  };

  async function candidatesOf(
    callerRel: string,
    name: string,
    qualifier: string,
  ): Promise<string[]> {
    const graph = await buildCodeGraph(root);
    resolveCallSites(
      graph,
      graph.symbolsByFile,
      graph.outgoingCallsByFile,
      graph.rustBindingsByFile,
      graph.rustCrateRootByFile,
      graph.rustInlineScopedCalls,
      graph.rustInlineDeclaredSymbols,
      graph.rustCrateRootsByFile,
    );
    const edge = (graph.outgoingCallsByFile.get(callerRel) ?? []).find(
      (e) => e.calleeName === name && e.calleeQualifier === qualifier,
    );
    expect(edge, `no qualified call to ${qualifier}::${name} in ${callerRel}`).toBeDefined();
    return (edge?.calleeCandidates ?? []).slice().sort();
  }

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "socraticode-rust-walk-"));

    write("Cargo.toml", '[package]\nname = "sib"\nedition = "2021"\n');
    write(
      "src/lib.rs",
      "pub mod a;\npub mod caller;\npub mod deep;\npub mod leaf;\npub mod other;\npub mod support;\n",
    );
    // The module the path names. Nothing in the crate imports `a/b.rs`
    // directly — `a/mod.rs` declares it — so only a walk reaches it.
    write("src/a/mod.rs", "pub mod b;\n");
    // A type by the same name lives in both, so the module prefix of a type
    // qualifier is what decides which one — and it is walked, not suffixed.
    write(
      "src/a/b.rs",
      "pub fn f() -> u32 { 1 }\n\npub struct Tipo;\n\nimpl Tipo {\n    pub fn metodo() -> u32 { 41 }\n}\n",
    );
    // The homonym: same last two segments, a different module.
    write("src/other/mod.rs", "pub mod a;\n");
    // A module the caller imports whose path ends in `a/missing`, which is
    // what a suffix match reaches for `crate::a::missing` — a path that does
    // not name it, since `src/a/` has no `missing`.
    write("src/other/a/mod.rs", "pub mod b;\npub mod missing;\n");
    write("src/other/a/missing.rs", "pub fn f() -> u32 { 51 }\n");
    write(
      "src/other/a/b.rs",
      "pub fn f() -> u32 { 2 }\n\npub struct Tipo;\n\nimpl Tipo {\n    pub fn metodo() -> u32 { 42 }\n}\n",
    );
    write(
      "src/caller.rs",
      "use crate::other::a::{b, missing as _m};\n\npub fn go() -> u32 {\n    let _ = b::f();\n    crate::a::b::f()\n}\n\npub fn deeper() -> u32 {\n    crate::deep::leaf::g()\n}\n\npub fn by_path() -> u32 {\n    crate::a::b::Tipo::metodo()\n}\n\npub fn half_walked() -> u32 {\n    crate::a::missing::f()\n}\n",
    );
    // A `crate::` written in an integration test is the test's own crate, and
    // its modules are filed beside it. The library has a `support` of its own,
    // which is what reading the test's `crate::` as the library answers with.
    write("src/support.rs", "pub fn helper() -> u32 { 10 }\n");
    write("tests/support.rs", "pub fn helper() -> u32 { 20 }\n");
    write(
      "tests/t.rs",
      "mod support;\n\n#[test]\nfn t() {\n    let got = crate::support::helper();\n    assert_eq!(got, 20);\n}\n",
    );
    // An ordinary module written as `deep.rs`, whose child is filed under the
    // directory named after it, and a homonym of that child sitting beside
    // `deep.rs` itself. A crate root takes its children from its own directory
    // whatever it is called, so a module mistaken for one answers with the
    // homonym.
    write("src/deep.rs", "pub mod leaf;\n");
    write("src/deep/leaf.rs", "pub fn g() -> u32 { 1 }\n");
    write("src/leaf.rs", "pub fn g() -> u32 { 2 }\n");
  });

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("reaches a sibling module the caller never imports, and not its homonym", async () => {
    // The regression: `crate::a::b::f()` is `src/a/b.rs`. `src/other/a/b.rs`
    // is a dependency of the caller and its path ends in `a/b`, which is what
    // a suffix match answers with — a file this path does not name.
    expect(await candidatesOf("src/caller.rs", "f", "crate::a::b")).toEqual([
      "src/a/b.rs::f#1",
    ]);
  });

  it("keeps the imported homonym reachable under the name it was bound to", async () => {
    // The other half of the same fixture: narrowing `crate::a::b` must not
    // move `b::f()`, which really is the imported `other::a::b`.
    expect(await candidatesOf("src/caller.rs", "f", "b")).toEqual([
      "src/other/a/b.rs::f#1",
    ]);
  });

  it("files an integration test's modules beside the test, not under its name", async () => {
    // cargo 1.90.0 runs this fixture's `tests/t.rs` green asserting 20, so
    // `crate::support` there is `tests/support.rs`. Reading the test as an
    // ordinary module files its children under `tests/t/` and finds nothing;
    // reading its `crate::` as the library answers `src/support.rs`.
    expect(await candidatesOf("tests/t.rs", "helper", "crate::support")).toEqual([
      "tests/support.rs::helper#1",
    ]);
  });

  it("files an ordinary module's children under its own name, not beside it", async () => {
    // The other side of the same question, and the one a walk needs at every
    // hop: `src/deep.rs` is not a crate root, so `mod leaf;` written in it is
    // `src/deep/leaf.rs` and not the `src/leaf.rs` sitting beside it. cargo
    // 1.98.0 on this fixture returns 1 for `crate::deep::leaf::g()` and 2 for
    // `crate::leaf::g()`, so answering with the second is a different
    // function, reported as `unique`.
    expect(await candidatesOf("src/caller.rs", "g", "crate::deep::leaf")).toEqual([
      "src/deep/leaf.rs::g#1",
    ]);
  });

  it("walks the module prefix of a type qualifier too, not just a plain path", async () => {
    // The other half of the walk, and the one that had no test: the prefix of
    // `crate::a::b::Tipo::metodo()` says *which* `Tipo`. Matched by suffix, it
    // reaches `src/other/a/b.rs` as well — the caller imports that file and
    // its path ends in `a/b` — and the answer becomes two types Rust never
    // confuses. cargo 1.98 on this fixture: the path form returns 41 and the
    // imported form returns 42, two different functions.
    expect(await candidatesOf("src/caller.rs", "metodo", "crate::a::b::Tipo")).toEqual([
      "src/a/b.rs::metodo#6",
    ]);
  });

  it("does not fall back to a suffix after the walk entered a module", async () => {
    // Two empty answers that are not the same. The walk reaches `src/a/`,
    // which declares no `missing`, so the path names nothing — rustc:
    // `error[E0433]: cannot find missing in a`. Falling back to the suffix
    // there picks `src/other/a/missing.rs`, which the caller does import and
    // whose path ends the same way, and reports it `unique`. The fallback is
    // for where the walk never entered a module at all, which is a different
    // silence.
    expect(await candidatesOf("src/caller.rs", "f", "crate::a::missing")).toEqual([]);
  });
});
