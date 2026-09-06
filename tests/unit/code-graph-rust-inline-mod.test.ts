// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCodeGraph } from "../../src/services/code-graph.js";
import { resolveCallSites } from "../../src/services/graph-symbol-resolution.js";
import type { SymbolEdge } from "../../src/types.js";

/**
 * What `super::` means when the call is written inside an inline `mod`.
 *
 * `super` counts modules, and an inline `mod` is one: inside
 * `#[cfg(test)] mod tests { … }` written in `a/b.rs`, `super::helper()` is
 * `b.rs`'s own `helper` and `super::super::sub::f()` is the `sub` of `b.rs`'s
 * parent. Resolution knows only files, so unless the nesting is accounted for
 * where it is still visible — in the extractor — both answer one module too
 * high: the parent's `helper`, and the grandparent's `sub`. Not a wider
 * answer, a different one, and reported as `unique`.
 *
 * This goes through the real `buildCodeGraph` pass rather than handing a
 * qualifier to `resolveCallSites`, because the qualifier is exactly what is
 * under test: by the time resolution sees it, it must already read as the file
 * would have written it.
 */
describe("Rust `super::` written inside an inline mod", () => {
  let root: string;
  let qualified: Map<string, SymbolEdge>;
  /** Kept so a test can check the fixture still declares what it is about. */
  let symbolsOf: (file: string) => string[];

  const write = (rel: string, body: string): void => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  };

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "socraticode-rust-inline-mod-"));

    write("Cargo.toml", '[package]\nname = "inlinemod"\nedition = "2021"\n');
    // The crate root reaches `a::c` by naming modules, and `only_inside` is
    // not in `c`'s own module — it is in `c`'s inline `mod holder`. rustc:
    // `error[E0425]: cannot find function only_inside in module crate::a::c`.
    write(
      "src/lib.rs",
      `pub mod a;
pub mod sub;
pub mod tipo;
pub mod riesporta;
pub mod glob;

pub fn from_root() -> u32 { crate::a::c::only_inside() }
pub fn by_name() -> u32 { crate::riesporta::per_nome() }
pub fn by_glob() -> u32 { crate::glob::only_via_glob() }
pub fn past_the_glob() -> u32 { crate::glob::nascosto() }
pub fn by_self_alias() -> u32 { A::helper() }
use crate::a::{self as A};
use self as ThisModule;
pub fn local_helper() -> u32 { 41 }
pub fn by_bare_self_alias() -> u32 { ThisModule::local_helper() }
pub fn past_nested_glob() -> u32 { crate::glob::troppo_profondo() }
`,
    );
    // The two ways a file lifts a name out of its own inline `mod` to its top
    // level. From the file's module Rust reaches both — cargo 1.98 runs a
    // crate of this shape green — so refusing them because the symbol sits
    // inside an inline `mod` withdraws answers that are right. tokio does the
    // explicit form in `net/unix/ucred.rs` and the glob in
    // `runtime/scheduler/multi_thread/counters.rs`, 35 calls between them.
    write("src/riesporta.rs", `mod imp {
    pub fn per_nome() -> u32 { 22 }
}

pub(crate) use self::imp::per_nome;
`);
    write("src/glob.rs", `mod imp {
    pub fn only_via_glob() -> u32 { 31 }

    mod hidden {
        pub fn troppo_profondo() -> u32 { 33 }
    }
}

mod altro {
    pub fn nascosto() -> u32 { 32 }
}

pub use imp::*;
`);
    // The same reach written as `super::`, from a sibling of `c`. Same module,
    // same refusal — the spelling of the path is not what decides it.
    write("src/tipo.rs", `pub fn from_sibling() -> u32 { super::a::c::only_inside() }

#[cfg(test)]
mod tests {
    pub struct Local;

    impl Local {
        pub fn make() -> u32 { 7 }
    }

    // Written outside the assert: a macro body is one token tree, so a call
    // inside it is never extracted at all.
    #[test]
    fn reaches_its_own_inline_type() {
        let got = Local::make();
        assert_eq!(got, 7);
    }
}
`);
    write("src/sub.rs", "pub fn f() -> u32 { 1 }\npub fn h() -> u32 { 8 }\n");
    write("src/a.rs", `pub mod b;
pub mod c;
pub mod d;
pub mod sub;

pub fn helper() -> u32 { 2 }
`);
    // The name exists in this file only inside an inline `mod`, so from
    // `tests` there is nothing for `super::only_inside()` to reach. Checked
    // against rustc, which answers E0425 for exactly this shape.
    write("src/a/c.rs", `mod holder {
    pub fn only_inside() -> u32 { 11 }
}

#[cfg(test)]
mod tests {
    #[test]
    fn nothing_at_the_file_top_level() {
        let _ = super::only_inside();
    }
}
`);
    // The common shape, and the one that must not be lost: a `super::` call in
    // `mod tests` in a file with no homonym inside any inline `mod`. It is 5
    // edges on tokio 1.40.0 and 4 on the private tree.
    write("src/a/d.rs", `pub fn lone() -> u32 { 12 }

#[cfg(test)]
mod tests {
    #[test]
    fn the_common_shape_still_resolves() {
        let _ = super::lone();
    }
}
`);
    write("src/a/sub.rs", "pub fn f() -> u32 { 3 }\n");
    write("src/a/b/sub.rs", "pub fn g() -> u32 { 5 }\n");
    write("src/a/b/inner.rs", "pub fn probe() -> u32 { 7 }\n");
    write("src/a/b.rs", `pub mod sub;
pub mod inner;
use crate::sub as aliased;

pub fn helper() -> u32 { 4 }

#[cfg(test)]
mod tests {
    #[test]
    fn one_hop_is_this_file() {
        let _ = super::helper();
    }

    #[test]
    fn self_is_the_inline_mod() {
        let _ = self::helper();
    }

    #[test]
    fn one_hop_then_a_module() {
        let _ = super::sub::g();
    }

    #[test]
    fn one_hop_then_an_imported_name() {
        let _ = super::aliased::h();
    }

    #[test]
    fn two_hops_is_the_parent() {
        let _ = super::super::sub::f();
    }

    pub fn helper() -> u32 { 9 }

    struct Probe;

    impl Probe {
        fn twin() -> u32 { 11 }

        fn calls_its_own() -> u32 {
            Self::twin()
        }
    }

    mod deeper {
        #[test]
        fn fewer_hops_than_modules() {
            let _ = super::inner::probe();
        }

        #[test]
        fn a_scope_with_no_file() {
            let _ = super::helper();
        }
    }

    mod sibling {
        pub fn helper() -> u32 { 10 }
    }

    mod inner {
        pub fn probe() -> u32 { 6 }
    }
}
`);

    const graph = await buildCodeGraph(root);
    resolveCallSites(
      graph,
      graph.symbolsByFile,
      graph.outgoingCallsByFile,
      graph.rustBindingsByFile,
      graph.rustCrateRootByFile,
      graph.rustInlineScopedCalls,
      graph.rustInlineDeclaredSymbols,
    );
    // Keyed by the function the call is written in as well as by callee and
    // qualifier. `super::helper()` and `self::helper()` both reach resolution
    // as `helper@self` — the first because the rewrite consumed its one
    // `super`, the second because that is how it was written — so on the callee
    // and qualifier alone they would be one entry, and whichever came last
    // would silently stand for both. Two files also write `super::` calls of
    // their own, and the caller keeps those apart too.
    symbolsOf = (file) =>
      (graph.symbolsByFile.get(file) ?? [])
        .filter((s) => s.name !== "<module>")
        .map((s) => s.id);
    qualified = new Map();
    for (const file of ["src/a/b.rs", "src/a/c.rs", "src/a/d.rs", "src/lib.rs", "src/tipo.rs"]) {
      for (const edge of graph.outgoingCallsByFile.get(file) ?? []) {
        if (!edge.calleeQualifier) continue;
        const caller = edge.callerId.split("::").pop()?.split("#")[0] ?? "";
        const key = `${caller}|${edge.calleeQualifier}::${edge.calleeName}`;
        expect(qualified.has(key), `two calls share the key ${key}`).toBe(false);
        qualified.set(key, edge);
      }
    }
  });

  /** The one qualified call `caller` writes as `qualifier::name`. */
  const edgeFor = (caller: string, qualifier: string, name: string): SymbolEdge => {
    const edge = qualified.get(`${caller}|${qualifier}::${name}`);
    expect(edge, `no call to ${qualifier}::${name} in ${caller}`).toBeDefined();
    return edge as SymbolEdge;
  };

  /** Its candidates, sorted. */
  const candidatesOf = (caller: string, qualifier: string, name: string): string[] =>
    edgeFor(caller, qualifier, name).calleeCandidates.slice().sort();

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("reads one `super` as the file the inline mod is written in", () => {
    // Read one module too high, this answers `src/a.rs::helper` — a file that
    // does declare a `helper`, so the wrong answer arrives as `unique`.
    const edge = edgeFor("one_hop_is_this_file", "self", "helper");
    expect(edge.confidence).toBe("local");
    expect(candidatesOf("one_hop_is_this_file", "self", "helper"))
      .toContain("src/a/b.rs::helper#5");
  });

  it("answers it with the file's top level and nothing an inline mod holds", () => {
    // The maintainer's case. First that the fixture is still the case: `b.rs`
    // has to declare three `helper`s for this to prove anything — `#5` at its
    // top level, `#34` in `tests`, `#59` in `tests::sibling` — and a fixture
    // that quietly lost one of them would leave the assertion below green and
    // empty.
    expect(symbolsOf("src/a/b.rs").filter((id) => id.includes("::helper#"))).toEqual([
      "src/a/b.rs::helper#5",
      "src/a/b.rs::helper#34",
      "src/a/b.rs::helper#59",
    ]);

    // From `tests`, `super::helper()` names the file's own module, and rustc
    // binds the top-level one: a crate of this shape compiles with that
    // assertion passing, and with the top-level `helper` removed it is E0425.
    //
    // So `#34` and `#59` are not a wider answer, they are calls Rust cannot
    // make from where this one is written. Handing them back put two symbols
    // in front of whoever walks the candidates for an impact analysis.
    expect(candidatesOf("one_hop_is_this_file", "self", "helper"))
      .toEqual(["src/a/b.rs::helper#5"]);
  });

  it("refuses a `self::` path written inside an inline mod", () => {
    // `self` is the module the path is written in, so here it is `tests`, and
    // rustc binds `tests::helper` — not the file's. `tests` has no file and no
    // spelling resolution can follow, which is the refusal already in place
    // for a `super::` path rooted the same way.
    //
    // Without it this path would be read as the file's own module and answered
    // with the top-level `#5`, which is the one `helper` Rust does *not* mean
    // here: a wrong answer stated as `local`.
    const edge = edgeFor("self_is_the_inline_mod", "self", "helper");
    expect(edge.calleeQualifier).toBe("self");
    expect(edge.calleeCandidates).toEqual([]);
    expect(edge.confidence).toBe("unresolved");
  });

  it("refuses the call when the file's top level declares nothing of that name", () => {
    // `c.rs` declares `only_inside` inside `mod holder` and nowhere else, so
    // from `tests` there is nothing to reach: rustc answers E0425 for exactly
    // this shape. The edge keeps its qualifier and goes unresolved rather than
    // pointing at the one declaration in the file that Rust cannot call.
    const edge = edgeFor("nothing_at_the_file_top_level", "self", "only_inside");
    expect(edge.calleeQualifier).toBe("self");
    expect(edge.calleeCandidates).toEqual([]);
    expect(edge.confidence).toBe("unresolved");
  });

  it("still resolves the common shape, where no inline mod declares the name", () => {
    // The form this must not cost anything: `super::lone()` in `mod tests`, in
    // a file whose only `lone` is at its top level. It is 5 edges on tokio
    // 1.40.0 and 4 on the private tree, and all 9 are still answered.
    const edge = edgeFor("the_common_shape_still_resolves", "self", "lone");
    expect(edge.confidence).toBe("local");
    expect(edge.calleeCandidates).toEqual(["src/a/d.rs::lone#1"]);
  });

  it("leaves `Self::` alone: it is the implementing type, not a module", () => {
    // `Self::twin()` inside `#[cfg(test)] mod tests` names the type the `impl`
    // is for, which is right there in the inline mod. Reading `Self` as the
    // lowercase `self` would refuse it and drop a call the graph can answer —
    // and tokio writes this shape inside its test modules.
    const edge = edgeFor("calls_its_own", "Self", "twin");
    expect(edge.confidence).toBe("local");
    expect(edge.calleeCandidates).toEqual(["src/a/b.rs::twin#39"]);
  });

  it("reads two `super` as that file's parent", () => {
    // `src/sub.rs` also declares `f`, and is what one hop too many reaches.
    expect(candidatesOf("two_hops_is_the_parent", "super::sub", "f"))
      .toEqual(["src/a/sub.rs::f#1"]);
  });

  it("keeps what is left of the path relative to that file", () => {
    // `super::sub` inside the inline mod is `b.rs`'s own `sub` module.
    expect(candidatesOf("one_hop_then_a_module", "sub", "g")).toEqual(["src/a/b/sub.rs::g#1"]);
  });

  it("lets what is left reach a name the file imported", () => {
    // `super::aliased` is the file's own `use crate::sub as aliased;`. In Rust
    // a module's namespace holds the names its `use` declarations bring in, so
    // the leftover has to stay bare: read as `self::aliased` it would be
    // matched against the file's modules alone, and answer nothing.
    expect(candidatesOf("one_hop_then_an_imported_name", "aliased", "h"))
      .toEqual(["src/sub.rs::h#2"]);
  });

  it("leaves a path rooted in an inline mod unresolved, with its qualifier", () => {
    // Two inline modules deep and one `super`: the path is rooted in `tests`,
    // which has no file. Answering with `b.rs` would hand back every `helper`
    // the file holds — including `tests::sibling`'s, which Rust cannot reach
    // from `tests::deeper` — and whoever walks the candidates would follow it.
    const edge = edgeFor("a_scope_with_no_file", "super", "helper");
    expect(edge.calleeCandidates).toEqual([]);
    expect(edge.confidence).toBe("unresolved");
  });

  it("does not answer a rooted path with the file either", () => {
    // The same rule for a path that continues: `super::inner` is `tests`'s own
    // `inner`, and `b.rs` declares a `mod inner;` of its own — a different
    // file — so neither that file nor the caller's is an answer.
    const edge = edgeFor("fewer_hops_than_modules", "super::inner", "probe");
    expect(edge.calleeCandidates).toEqual([]);
    expect(edge.confidence).toBe("unresolved");
  });

  it("refuses an inline-mod symbol reached through `crate::`, not only `self`", () => {
    // The rule is the path, not the spelling. `crate::a::c` names `c`'s own
    // module, and `only_inside` is declared in `c`'s inline `mod holder` —
    // cargo 1.98 on this shape: `error[E0425]: cannot find function
    // only_inside in module crate::a::c`.
    //
    // The file is the scope this resolution has, so the id comes back with the
    // rest; refusing it is what keeps a `unique` off a symbol Rust cannot call
    // from here. Before this, the filter asked whether the qualifier was
    // literally `self`, and every other spelling of the same reach answered
    // `unique`.
    const edge = edgeFor("from_root", "crate::a::c", "only_inside");
    expect(edge.calleeCandidates).toEqual([]);
    expect(edge.confidence).toBe("unresolved");
  });

  it("refuses it through `super::` too", () => {
    // Same module reached by climbing instead of by rooting. A rule written
    // per spelling would need one branch per spelling, and would keep missing
    // the next one.
    const edge = edgeFor("from_sibling", "super::a::c", "only_inside");
    expect(edge.calleeCandidates).toEqual([]);
    expect(edge.confidence).toBe("unresolved");
  });

  it("still reaches a type an inline mod declares, from inside that mod", () => {
    // The other side, and the reason the refusal follows the path rather than
    // the symbol: `Local` is declared inside `mod tests` and `Local::make()`
    // is written inside the same `mod`, where Rust does reach it — cargo 1.98
    // runs this fixture's assertion green. A bare type qualifier is not a
    // module path, so nothing is dropped from it; refusing here would turn a
    // correct `unique` into `unresolved`.
    // `local` because the symbol is in the caller's own file, which is what
    // that label has always meant here — what is under test is the candidate,
    // which must still be there.
    const edge = edgeFor("reaches_its_own_inline_type", "Local", "make");
    expect(edge.calleeCandidates).toEqual(["src/tipo.rs::make#8"]);
    expect(edge.confidence).toBe("local");
  });

  it("keeps a name an inline mod re-exports by name to the file's top level", () => {
    // From a file's own module Rust reaches what the top level declares *and
    // what it imports*: `pub(crate) use self::imp::per_nome;` puts `per_nome`
    // there as surely as writing it there. cargo 1.98 runs the assertion
    // green. Refusing it on the grounds that the declaration sits inside
    // `mod imp` withdrew 1 right answer in tokio's `net/unix/ucred.rs`.
    const edge = edgeFor("by_name", "crate::riesporta", "per_nome");
    expect(edge.calleeCandidates).toEqual(["src/riesporta.rs::per_nome#2"]);
    expect(edge.confidence).toBe("unique");
  });

  it("keeps one the file re-exports with a glob, which cannot be enumerated", () => {
    // `pub use imp::*;` carries names this cannot list — the module it reads
    // from need not be a file — so the glob is recorded under `*` and read as
    // "this might be reachable". That keeps the refusal to what is provably
    // out of reach, and it is what tokio's `counters.rs` needs: 34 calls to
    // `super::counters::inc_num_inc_notify_local()` and its neighbours.
    const edge = edgeFor("by_glob", "crate::glob", "only_via_glob");
    expect(edge.calleeCandidates).toEqual(["src/glob.rs::only_via_glob#2"]);
    expect(edge.confidence).toBe("unique");
  });

  it("does not let a glob carry a sibling inline mod it never reads from", () => {
    // The other half of the exemption above, and the one it was missing:
    // `pub use imp::*;` exports what `imp` exports, so `nascosto` in a sibling
    // `mod altro { … }` stays out. cargo 1.98 on this shape:
    // `error[E0425]: cannot find function nascosto in module crate::glob`.
    // Exempting on "the file has some glob" answered it `unique`.
    const edge = edgeFor("past_the_glob", "crate::glob", "nascosto");
    expect(edge.calleeCandidates).toEqual([]);
    expect(edge.confidence).toBe("unresolved");
  });

  it("does not let a glob flatten a nested inline mod", () => {
    // `pub use imp::*;` carries the names exported directly by `imp`; it does
    // not flatten `imp::hidden` into the file's top level. Treating only the
    // outermost owner as the source makes this look callable when rustc does
    // not expose it there.
    const edge = edgeFor("past_nested_glob", "crate::glob", "troppo_profondo");
    expect(edge.calleeCandidates).toEqual([]);
    expect(edge.confidence).toBe("unresolved");
  });

  it("reads `use crate::a::{self as A};` as the module, not as `a::self`", () => {
    // Inside a use list, `self` is the module the list hangs off, so the
    // binding names `crate::a`. Recorded literally as `crate::a::self` it
    // matched no module and `A::helper()` went unresolved. cargo 1.98
    // compiles the form and tokio writes it — `use super::unix::{self as
    // os_impl};` in `signal/ctrl_c.rs`, which this recovers.
    const edge = edgeFor("by_self_alias", "A", "helper");
    expect(edge.calleeCandidates).toEqual(["src/a.rs::helper#6"]);
    expect(edge.confidence).toBe("unique");
  });

  it("reads `use self as ThisModule;` as the file's own module", () => {
    // A top-level bare `self` is a real anchor, not an empty use path.
    const edge = edgeFor("by_bare_self_alias", "ThisModule", "local_helper");
    expect(edge.calleeCandidates).toEqual(["src/lib.rs::local_helper#14"]);
    expect(edge.confidence).toBe("local");
  });
});
