// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import { Lang } from "@ast-grep/napi";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ensureDynamicLanguages } from "../../src/services/code-graph.js";
import { listSymbols } from "../../src/services/graph-impact.js";
import {
  extractSymbolsAndCalls,
  rawCallsToUnresolvedEdges,
  resetSymbolExtractionWarnings,
} from "../../src/services/graph-symbols.js";
import { logger } from "../../src/services/logger.js";

beforeAll(async () => {
  await ensureDynamicLanguages();
});

describe("graph-symbols", () => {
  describe("TypeScript/JavaScript", () => {
    it("extracts function declarations and synthesizes a <module> symbol", () => {
      const src = `
function foo() { return 1; }
function bar() { return foo(); }
`;
      const out = extractSymbolsAndCalls(src, Lang.TypeScript, ".ts", "src/a.ts");
      const names = out.symbols.map((s) => s.name).sort();
      expect(names).toContain("<module>");
      expect(names).toContain("foo");
      expect(names).toContain("bar");
    });

    it("attributes calls inside a function to that function as caller", () => {
      const src = `
function foo() {}
function bar() { foo(); }
`;
      const out = extractSymbolsAndCalls(src, Lang.TypeScript, ".ts", "src/b.ts");
      const fooCall = out.rawCalls.find((c) => c.calleeName === "foo");
      expect(fooCall).toBeDefined();
      expect(fooCall?.callerId).toContain("::bar#");
    });

    it("extracts class methods with qualified names", () => {
      const src = `
class Foo {
  bar() { return 1; }
  baz() { return this.bar(); }
}
`;
      const out = extractSymbolsAndCalls(src, Lang.TypeScript, ".ts", "src/c.ts");
      const qnames = out.symbols.map((s) => s.qualifiedName);
      expect(qnames).toContain("Foo.bar");
      expect(qnames).toContain("Foo.baz");
      const kinds = out.symbols.filter((s) => s.qualifiedName === "Foo.bar").map((s) => s.kind);
      expect(kinds).toContain("method");
    });

    it("extracts arrow function constants", () => {
      const src = `
export const validate = (x: number) => x > 0;
const helper = function () { return 42; };
`;
      const out = extractSymbolsAndCalls(src, Lang.TypeScript, ".ts", "src/d.ts");
      const names = out.symbols.map((s) => s.name);
      expect(names).toContain("validate");
      expect(names).toContain("helper");
    });

    it("extracts interfaces, type aliases, enums, and plain constants (issue #132)", () => {
      const src = `
export interface UserProfile { id: string; name: string; }
export type JobOfferSnapshot = { id: string; score: number; };
export enum OfferStatus { Active, Expired }
export const STALE_EVALUATION_WHERE = "status = 'stale'";
export let retryCount = 3;
`;
      const out = extractSymbolsAndCalls(src, Lang.TypeScript, ".ts", "src/types.ts");
      const syms = new Map(out.symbols.map((s) => [s.name, s]));
      expect(syms.get("UserProfile")?.kind).toBe("interface");
      expect(syms.get("JobOfferSnapshot")?.kind).toBe("type");
      expect(syms.get("OfferStatus")?.kind).toBe("enum");
      expect(syms.get("STALE_EVALUATION_WHERE")?.kind).toBe("variable");
      expect(syms.get("retryCount")?.kind).toBe("variable");
    });

    it("extracts import, re-export, and type reference edges (issue #132)", () => {
      const src = `
import { JobOfferSnapshot, STALE_EVALUATION_WHERE } from "./types";
import type { UserProfile } from "./user";
import DefaultService from "./service";
export { OfferStatus } from "./enums";

export function processOffer(offer: JobOfferSnapshot): UserProfile {
  const query = STALE_EVALUATION_WHERE;
  return { id: "1", name: query };
}
`;
      const out = extractSymbolsAndCalls(src, Lang.TypeScript, ".ts", "src/worker.ts");
      const calleeNames = out.rawCalls.map((c) => c.calleeName);
      expect(calleeNames).toContain("JobOfferSnapshot");
      expect(calleeNames).toContain("STALE_EVALUATION_WHERE");
      expect(calleeNames).toContain("UserProfile");
      expect(calleeNames).toContain("DefaultService");
      expect(calleeNames).toContain("OfferStatus");

      const processOfferCall = out.rawCalls.find(
        (c) => c.calleeName === "JobOfferSnapshot" && c.callerId.includes("::processOffer#"),
      );
      expect(processOfferCall).toBeDefined();
    });

    it("resolves aliased imports to their original exported names", () => {
      const src = `
import { calculateSum as sum, UserConfig as Config, API_KEY as KEY } from "./utils";

export function execute(cfg: Config): number {
  const secret = KEY;
  return sum(1, 2);
}
`;
      const out = extractSymbolsAndCalls(src, Lang.TypeScript, ".ts", "src/client.ts");
      const calleeNames = out.rawCalls.map((c) => c.calleeName);
      expect(calleeNames).toContain("calculateSum");
      expect(calleeNames).toContain("UserConfig");
      expect(calleeNames).toContain("API_KEY");
      expect(calleeNames).not.toContain("sum");
      expect(calleeNames).not.toContain("Config");
      expect(calleeNames).not.toContain("KEY");

      const executeCalls = out.rawCalls.filter((c) => c.callerId.includes("::execute#"));
      const executeCallees = executeCalls.map((c) => c.calleeName);
      expect(executeCallees).toContain("calculateSum");
      expect(executeCallees).toContain("UserConfig");
      expect(executeCallees).toContain("API_KEY");
    });

    it("resolves namespace imports to the accessed exported symbols", () => {
      const src = `
import * as Utils from "./utils";

export function run(config: Utils.DatabaseConfig): number {
  const defaultVal = Utils.DEFAULT_LIMIT;
  return Utils.add(defaultVal, 10);
}
`;
      const out = extractSymbolsAndCalls(src, Lang.TypeScript, ".ts", "src/caller.ts");
      const runCalls = out.rawCalls.filter((c) => c.callerId.includes("::run#"));
      const runCallees = runCalls.map((c) => c.calleeName);
      expect(runCallees).toContain("DatabaseConfig");
      expect(runCallees).toContain("DEFAULT_LIMIT");
      expect(runCallees).toContain("add");
    });
  });

  describe("Python", () => {
    it("extracts def and class symbols", () => {
      const src = `
def foo():
    return 1

class Bar:
    def baz(self):
        return foo()
`;
      const out = extractSymbolsAndCalls(src, "python" as unknown as Lang, ".py", "app.py");
      const names = out.symbols.map((s) => s.name);
      expect(names).toContain("foo");
      expect(names).toContain("Bar");
      expect(names).toContain("baz");
    });
  });

  describe("Go", () => {
    it("extracts func declarations", () => {
      const src = `
package main

func Foo() int { return 1 }

func Bar() int { return Foo() }
`;
      const out = extractSymbolsAndCalls(src, "go" as unknown as Lang, ".go", "main.go");
      const names = out.symbols.map((s) => s.name);
      expect(names).toContain("Foo");
      expect(names).toContain("Bar");
    });
  });

  describe("rawCallsToUnresolvedEdges", () => {
    it("converts raw calls to unresolved SymbolEdge objects", () => {
      const raw = [
        {
          callerId: "src/a.ts::foo#1",
          calleeName: "bar",
          callSite: { file: "src/a.ts", line: 5 },
        },
      ];
      const edges = rawCallsToUnresolvedEdges(raw);
      expect(edges).toHaveLength(1);
      expect(edges[0].confidence).toBe("unresolved");
      expect(edges[0].calleeCandidates).toEqual([]);
      expect(edges[0].calleeName).toBe("bar");
    });
  });

  describe("Rust", () => {
    it("extracts fn and impl methods", () => {
      const src = `
fn foo() -> i32 { 1 }

struct S;
impl S {
    fn bar(&self) -> i32 { foo() }
}
`;
      const out = extractSymbolsAndCalls(src, "rust" as unknown as Lang, ".rs", "lib.rs");
      const names = out.symbols.map((s) => s.name);
      expect(names).toContain("foo");
      expect(names).toContain("bar");
      expect(out.symbols.some((s) => s.name === "<module>")).toBe(true);
      // The fixture above already declared `struct S`, and nothing asserted it:
      // only `function_item` was read, so every type a crate exposes was
      // invisible to symbol lookup.
      expect(names).toContain("S");
    });

    it("extracts the items that are not functions, each under its own kind", () => {
      const src = `
pub struct Config { pub a: u32 }
pub union Either { a: u32, b: f32 }
pub enum Mode { One, Two }
pub trait Speaks { fn say(&self); }
pub type Alias = Config;
pub const LIMIT: u32 = 3;
pub static NAME: &str = "x";
pub fn build() -> Config { Config { a: 0 } }
`;
      const out = extractSymbolsAndCalls(src, "rust" as unknown as Lang, ".rs", "crates/x/src/lib.rs");
      const byName = new Map(out.symbols.map((s) => [s.name, s.kind]));
      // The kinds this file already gives these shapes: `struct` as C++, C# and
      // Swift give it, `trait` as Scala and PHP give it.
      expect(byName.get("Config")).toBe("struct");
      expect(byName.get("Either")).toBe("struct");
      expect(byName.get("Mode")).toBe("enum");
      expect(byName.get("Speaks")).toBe("trait");
      expect(byName.get("Alias")).toBe("type");
      expect(byName.get("LIMIT")).toBe("variable");
      expect(byName.get("NAME")).toBe("variable");
      // The function was already read; the point is that it still is.
      expect(byName.get("build")).toBe("function");
    });

    it("gives a Rust item the line it is declared on", () => {
      // A symbol whose position is wrong is worse than one that is missing: the
      // id is built from the line, so two items would collide or a lookup would
      // send the reader to the wrong place.
      const src = "\n\npub enum Mode { One }\n";
      const out = extractSymbolsAndCalls(src, "rust" as unknown as Lang, ".rs", "crates/x/src/lib.rs");
      const mode = out.symbols.find((s) => s.name === "Mode");
      expect(mode?.line).toBe(3);
      expect(mode?.endLine).toBe(3);
    });

    it("reads both declarations of one name under opposite cfgs", () => {
      // The graph has no feature resolution, so both are read — the same rule
      // the file graph already follows for `mod` under `#[cfg]`. On separate
      // lines their ids differ, because `makeId` carries the line. Two items of
      // one name on the *same* line would share an id; that is a property of
      // `makeId`, not of this extractor, and the pull request says so.
      const src = `
#[cfg(unix)] pub struct Sys { pub a: u32 }
#[cfg(windows)] pub struct Sys { pub b: u32 }
`;
      const out = extractSymbolsAndCalls(src, "rust" as unknown as Lang, ".rs", "crates/x/src/lib.rs");
      const sys = out.symbols.filter((s) => s.name === "Sys");
      expect(sys).toHaveLength(2);
      expect(new Set(sys.map((s) => s.id)).size).toBe(2);
      expect(sys.map((s) => s.line).sort()).toEqual([2, 3]);
    });

    it("returns the symbols in declaration order", () => {
      // A reader is shown a prefix of this list, not all of it: `listSymbols`
      // cuts at its limit in payload order. Collected in two passes the items
      // would all sit behind the functions, and on ripgrep's
      // `crates/core/flags/defs.rs` not one appeared under a limit of 200.
      const src = `
pub const FIRST: u32 = 1;
pub fn second() {}
pub struct Third;
pub fn fourth() {}
pub enum Fifth { A }
`;
      const out = extractSymbolsAndCalls(src, "rust" as unknown as Lang, ".rs", "crates/x/src/lib.rs");
      expect(out.symbols.map((s) => s.name)).toEqual([
        "<module>",
        "FIRST",
        "second",
        "Third",
        "fourth",
        "Fifth",
      ]);
    });

    it("keeps source order for declarations sharing a line, through a limited listing", () => {
      // Rust puts no weight on line breaks, so several items can share a line.
      // Ordering those by name would put a later declaration before an earlier
      // one, and `listSymbols` cuts at its limit in payload order — so at the
      // boundary the earlier declaration is the one that disappears. The key is
      // the byte offset, which no two declarations share.
      const src = "pub const ZULU: u8 = 1; pub struct Alpha; pub const Mike: u8 = 2;\n";
      const out = extractSymbolsAndCalls(src, "rust" as unknown as Lang, ".rs", "crates/x/src/lib.rs");
      expect(out.symbols.map((s) => s.name)).toEqual(["<module>", "ZULU", "Alpha", "Mike"]);
      expect(out.symbols[0].name).toBe("<module>");

      // And through the reader that does the cutting. A limit of 1 must show
      // the first declaration of the line, not the alphabetically first.
      const payload = {
        file: "crates/x/src/lib.rs",
        language: "rust",
        contentHash: "",
        symbols: out.symbols,
        outgoingCalls: [],
      };
      const release = Object.assign(() => {}, { token: Symbol("reader") });
      const cache = {
        acquireReader: () => release,
        getFilePayload: async () => payload,
      } as unknown as Parameters<typeof listSymbols>[0];

      return listSymbols(cache, { file: "crates/x/src/lib.rs", limit: 1 }).then((shown) => {
        expect(shown.map((s) => s.name)).toEqual(["ZULU"]);
      });
    });

    it("reads an associated type and const inside an impl, under a bare name", () => {
      // `safeFindAll` walks the whole tree, so an impl's contents are read.
      // The name carries no owner, the way a method's name already does not —
      // two impls of one trait therefore give two symbols of the same name.
      // Documented rather than changed: qualifying a name is a change to how
      // every language in this file names a member.
      const src = `
pub trait Conv { type Out; }
pub struct A;
pub struct B;
impl Conv for A { type Out = u32; }
impl Conv for B { type Out = u64; }
impl A { pub const MAX: u32 = 9; }
`;
      const out = extractSymbolsAndCalls(src, "rust" as unknown as Lang, ".rs", "crates/x/src/lib.rs");
      const outs = out.symbols.filter((s) => s.name === "Out");
      // Three: the trait's own declaration, and one per impl.
      expect(outs).toHaveLength(3);
      expect(outs.every((s) => s.kind === "type")).toBe(true);
      expect(outs.map((s) => s.line)).toEqual([2, 5, 6]);
      expect(out.symbols.some((s) => s.name === "MAX" && s.kind === "variable")).toBe(true);
    });

    it("reads a declaration that has no body, in a trait and in an extern block", () => {
      // A declaration without a definition is still what a reader looks up.
      // Rust writes both as `function_signature_item`, and a trait's own
      // associated type as `associated_type` — a different node from the
      // `type_item` an impl writes, which is why reading definitions alone left
      // a trait's contents unfindable.
      const src = `
pub trait Speaks {
    fn say(&self) -> u32;
    type Voice;
}
extern "C" {
    pub fn c_open(path: u32) -> u32;
    pub static C_LIMIT: u32;
}
`;
      const out = extractSymbolsAndCalls(src, "rust" as unknown as Lang, ".rs", "crates/x/src/lib.rs");
      const byName = new Map(out.symbols.map((s) => [s.name, s.kind]));
      expect(byName.get("say")).toBe("function");
      expect(byName.get("Voice")).toBe("type");
      expect(byName.get("c_open")).toBe("function");
      expect(byName.get("C_LIMIT")).toBe("variable");
      // The kind is `function` because that is what every Rust `fn` gets here,
      // an impl's methods included; a declared one is not a different species.
      expect(out.symbols.find((s) => s.name === "say")?.line).toBe(3);
    });

    it("reads a qualified call as a terminal name plus its qualifier", () => {
      // `extractCalleeNameJs` matched the chain pattern `[\w$.]+`, which stops
      // at the `:` of `::`, so every one of these produced no edge at all.
      const src = `
fn f() {
    let _ = plain();
    let _ = obj.method();
    let _ = Vec::new();
    let _ = std::fs::copy(a, b);
    let _ = Vec::<u8>::new();
    let _ = Vec::<Option<u8>>::with_capacity(1);
    let _ = self::helper();
    let _ = crate::a::b::run();
}
`;
      const out = extractSymbolsAndCalls(src, "rust" as unknown as Lang, ".rs", "crates/x/src/lib.rs");
      const seen = out.rawCalls.map((c) => `${c.calleeQualifier ?? ""}|${c.calleeName}`);
      expect(seen).toContain("|plain");
      // A method on a receiver has no path to narrow with: the name is all it knows.
      expect(seen).toContain("|method");
      expect(seen).toContain("Vec|new");
      expect(seen).toContain("std::fs|copy");
      // The turbofish is not part of the qualifier, and a nested generic must
      // not leave a stray `>` behind.
      expect(seen).toContain("Vec|new");
      expect(seen).toContain("Vec|with_capacity");
      expect(seen).toContain("self|helper");
      expect(seen).toContain("crate::a::b|run");
    });

    it("reads every link of a chain whose head is qualified", () => {
      // The whole chain used to yield nothing: ast-grep reports one node per
      // link and each node's text begins at the head, so the text-level
      // extractor died on the head's `::` for every link.
      const src = "fn f() { let _ = Path::new(p).components().all(g); }";
      const out = extractSymbolsAndCalls(src, "rust" as unknown as Lang, ".rs", "crates/x/src/lib.rs");
      const seen = out.rawCalls.map((c) => `${c.calleeQualifier ?? ""}|${c.calleeName}`);
      expect(seen).toContain("Path|new");
      expect(seen).toContain("|components");
      expect(seen).toContain("|all");
    });

    it("does not invent a callee for a form it cannot read", () => {
      // `<T as Tr>::go()` is a qualified path with syntax in it. It yields an
      // edge named `go`, qualified by text that resolution will refuse — which
      // is the point: an edge that says what it saw, not a guess.
      const src = "fn f() { let _ = <T as Tr>::go(); }";
      const out = extractSymbolsAndCalls(src, "rust" as unknown as Lang, ".rs", "crates/x/src/lib.rs");
      const go = out.rawCalls.find((c) => c.calleeName === "go");
      expect(go).toBeDefined();
      expect(go?.calleeQualifier).toBe("<T as Tr>");
    });

    it("collects the name each use puts in scope, alias included", () => {
      // The file graph cannot supply this: `rustUseLeafPath` strips ` as X`
      // before the path is recorded, so `Alias` names nothing downstream.
      const src = `
use crate::a::Type as Alias;
use crate::a::{Thing, Other as O};
use std::fs;
use crate::b::{self, Deep};
use crate::c::*;
use self as ThisModule;
`;
      const out = extractSymbolsAndCalls(src, "rust" as unknown as Lang, ".rs", "crates/x/src/lib.rs");
      const bindings = new Map((out.bindings ?? []).map((b) => [b.local, b.path]));
      expect(bindings.get("Alias")).toBe("crate::a::Type");
      expect(bindings.get("Thing")).toBe("crate::a::Thing");
      expect(bindings.get("O")).toBe("crate::a::Other");
      expect(bindings.get("fs")).toBe("std::fs");
      // `self` in a list binds the prefix's own last segment.
      expect(bindings.get("b")).toBe("crate::b");
      expect(bindings.get("Deep")).toBe("crate::b::Deep");
      // At the file top level, bare `self` names the file's own module. It must
      // keep that anchor rather than becoming an empty path.
      expect(bindings.get("ThisModule")).toBe("self");
      // A wildcard binds no name: what it brings in cannot be known from this
      // file, and guessing would widen resolution instead of narrowing it.
      expect(bindings.has("c")).toBe(false);
    });

    it("does not let a use written inside a scope bind the whole file", () => {
      // A `use` inside a `fn` or a `mod x { }` names something *there*. Taken
      // for the file's own, it would point a call in a different scope at a
      // different type — and resolution would state that as `unique`, which is
      // worse than saying nothing. `safeFindAll` walks the whole tree, so this
      // is what reading the file's top level rather than searching prevents.
      const src = `
use crate::a::Thing;

pub fn scoped() {
    use crate::b::Thing;
    let _ = Thing::make();
}

mod inner {
    use crate::c::Thing;
}
`;
      const out = extractSymbolsAndCalls(src, "rust" as unknown as Lang, ".rs", "crates/x/src/lib.rs");
      const paths = (out.bindings ?? []).filter((b) => b.local === "Thing").map((b) => b.path);
      expect(paths).toEqual(["crate::a::Thing"]);
    });
  });

  describe("Java / Kotlin / Scala (JVM family)", () => {
    it("extracts Java class and methods", () => {
      const src = `
public class Foo {
    public int bar() { return 1; }
    public int baz() { return bar(); }
}
`;
      const out = extractSymbolsAndCalls(src, "java" as unknown as Lang, ".java", "Foo.java");
      const names = out.symbols.map((s) => s.name);
      expect(names).toContain("Foo");
      expect(names).toContain("bar");
      expect(names).toContain("baz");
    });

    it("prefers the declared Java class name over parameter types in Spring Boot entrypoints", () => {
      const src = `
@SpringBootApplication
public class WorkflowFlowableApplication {
    public static void main(String[] args) {
        SpringApplication.run(WorkflowFlowableApplication.class, args);
    }
}
`;
      const out = extractSymbolsAndCalls(src, "java" as unknown as Lang, ".java", "WorkflowFlowableApplication.java");
      const names = out.symbols.map((s) => s.name);
      expect(names).toContain("WorkflowFlowableApplication");
      expect(names).not.toContain("String");
      expect(names).toContain("main");
    });

    it("does not treat Java test annotations as method names", () => {
      const src = `
class SecurityAuthClientRequireSubjectTest {
    @AfterEach
    void cleanup() {}

    @Test
    void requireSubjectThrows() {}

    @Test(timeout = 1000)
    void fastTest() {}
}
`;
      const out = extractSymbolsAndCalls(src, "java" as unknown as Lang, ".java", "SecurityAuthClientRequireSubjectTest.java");
      const names = out.symbols.map((s) => s.name);
      expect(names).toContain("SecurityAuthClientRequireSubjectTest");
      expect(names).toContain("cleanup");
      expect(names).toContain("requireSubjectThrows");
      expect(names).toContain("fastTest");
      expect(names).not.toContain("AfterEach");
      expect(names).not.toContain("Test");
    });

    it("preserves Java declarations when annotations share the same line", () => {
      const src = `
class InlineAnnotationTest {
    @Test void cleanup() {}
}
`;
      const out = extractSymbolsAndCalls(src, "java" as unknown as Lang, ".java", "InlineAnnotationTest.java");
      const names = out.symbols.map((s) => s.name);
      expect(names).toContain("InlineAnnotationTest");
      expect(names).toContain("cleanup");
      expect(names).not.toContain("Test");
    });

    it("extracts Kotlin top-level fun and class methods", () => {
      const src = `
fun greet(name: String): String = "Hi"

class Bar {
    fun work(): String = greet("x")
}
`;
      const out = extractSymbolsAndCalls(src, "kotlin" as unknown as Lang, ".kt", "main.kt");
      const names = out.symbols.map((s) => s.name);
      expect(names).toContain("greet");
      expect(names).toContain("Bar");
      expect(names).toContain("work");
    });

    it("extracts Scala def and class", () => {
      const src = `
class Foo {
  def bar(): Int = 1
  def size: Int = 1
  def now = Instant.now()
}

object Main {
  def main(args: Array[String]): Unit = println("hi")
}
`;
      const out = extractSymbolsAndCalls(src, "scala" as unknown as Lang, ".scala", "Main.scala");
      const names = out.symbols.map((s) => s.name);
      expect(names).toContain("bar");
      expect(names).toContain("size");
      expect(names).toContain("now");
      expect(names).toContain("main");
    });
  });

  describe("C#", () => {
    it("extracts class and methods", () => {
      const src = `
namespace App {
    public class Foo {
        public int Bar() { return 1; }
        public int Baz() { return Bar(); }
    }
}
`;
      const out = extractSymbolsAndCalls(src, "csharp" as unknown as Lang, ".cs", "Foo.cs");
      const names = out.symbols.map((s) => s.name);
      expect(names).toContain("Foo");
      expect(names).toContain("Bar");
      expect(names).toContain("Baz");
    });
  });

  describe("C / C++", () => {
    it("extracts C function definitions", () => {
      const src = `
int add(int a, int b) { return a + b; }

int main(void) {
    return add(2, 3);
}
`;
      const out = extractSymbolsAndCalls(src, "c" as unknown as Lang, ".c", "main.c");
      const names = out.symbols.map((s) => s.name);
      expect(names).toContain("add");
      expect(names).toContain("main");
    });

    it("extracts C++ class declarations and free functions", () => {
      // Note: inline class methods are `field_declaration` nodes in tree-sitter-cpp,
      // not `function_definition`, so the current extractor catches them only
      // when defined out-of-line. See language-coverage table in DEVELOPER.md.
      const src = `
class Foo {
public:
    int bar();
};

int Foo::bar() { return 1; }
int helper() { return 42; }
`;
      const out = extractSymbolsAndCalls(src, "cpp" as unknown as Lang, ".cpp", "Foo.cpp");
      const names = out.symbols.map((s) => s.name);
      expect(names).toContain("Foo");
      expect(names).toContain("helper");
      // Out-of-line method `Foo::bar` is detected as qualifiedName "Foo::bar".
      const qnames = out.symbols.map((s) => s.qualifiedName);
      expect(qnames.some((q) => q === "Foo::bar" || q === "bar")).toBe(true);
    });
  });

  describe("Ruby", () => {
    it("extracts def and class", () => {
      const src = `
def foo
  1
end

class Bar
  def baz
    foo
  end
end
`;
      const out = extractSymbolsAndCalls(src, "ruby" as unknown as Lang, ".rb", "app.rb");
      const names = out.symbols.map((s) => s.name);
      expect(names).toContain("foo");
      expect(names).toContain("Bar");
      expect(names).toContain("baz");
    });
  });

  describe("PHP", () => {
    it("extracts function and class methods", () => {
      const src = `<?php
function greet($name) {
  return "Hi " . $name;
}

class Foo {
  public function bar() {
    return greet("x");
  }
}
`;
      const out = extractSymbolsAndCalls(src, "php" as unknown as Lang, ".php", "index.php");
      const names = out.symbols.map((s) => s.name);
      expect(names).toContain("greet");
      expect(names).toContain("Foo");
      expect(names).toContain("bar");
    });
  });

  describe("Swift", () => {
    it("extracts Swift func and class", () => {
      const src = `
func greet(name: String) -> String { return "Hi" }

class Foo {
    func bar() -> String { return greet(name: "x") }
}
`;
      const out = extractSymbolsAndCalls(src, "swift" as unknown as Lang, ".swift", "App.swift");
      const names = out.symbols.map((s) => s.name);
      expect(names).toContain("greet");
      expect(names).toContain("Foo");
      expect(names).toContain("bar");
      // The fixture above already declared a class and asserted only its name.
      expect(out.symbols.find((s) => s.name === "Foo")?.kind).toBe("class");
    });

    it("takes the kind from the declaration keyword, not from the node kind", () => {
      // The grammar files class, struct, enum, actor and extension all under
      // `class_declaration`, so the node kind cannot tell them apart.
      const src = `
class C { var a: Int = 0 }
struct S { var a: Int }
enum E { case one }
protocol P { func f() }
actor A { var a: Int = 0 }
`;
      const out = extractSymbolsAndCalls(src, "swift" as unknown as Lang, ".swift", "App.swift");
      const byName = new Map(out.symbols.map((s) => [s.name, s.kind]));
      expect(byName.get("C")).toBe("class");
      expect(byName.get("S")).toBe("struct");
      expect(byName.get("E")).toBe("enum");
      expect(byName.get("P")).toBe("interface");
      // An actor keeps the `class` it already had: naming that form is a
      // separate question from reading the keyword.
      expect(byName.get("A")).toBe("class");
    });

    it("finds the keyword when a modifier precedes it", () => {
      // `public struct P` puts a `modifiers` node first and `indirect enum E`
      // an `indirect`, so the keyword is not reliably the first child — and
      // reading the head instead would misfile the commonest declaration in
      // real Swift.
      const src = `
public struct PS { var a: Int }
final class FC { var a: Int = 0 }
indirect enum IE { case one(IE) }
`;
      const out = extractSymbolsAndCalls(src, "swift" as unknown as Lang, ".swift", "App.swift");
      const byName = new Map(out.symbols.map((s) => [s.name, s.kind]));
      expect(byName.get("PS")).toBe("struct");
      expect(byName.get("FC")).toBe("class");
      expect(byName.get("IE")).toBe("enum");
    });

    it("does not take a nested declaration's keyword for the outer one", () => {
      // The keyword is searched among direct children only, so a `struct`
      // inside an extension's body cannot rename the extension.
      const src = `
extension C {
    struct Inner { var a: Int }
    func g() {}
}
`;
      const out = extractSymbolsAndCalls(src, "swift" as unknown as Lang, ".swift", "App.swift");
      const byName = new Map(out.symbols.map((s) => [s.name, s.kind]));
      expect(byName.get("C")).toBe("class");
      expect(byName.get("Inner")).toBe("struct");
      expect(byName.get("g")).toBe("function");
    });
  });

  describe("Bash", () => {
    it("extracts shell function definitions", () => {
      const src = `
greet() {
  echo "hi $1"
}

main() {
  greet "world"
}
`;
      const out = extractSymbolsAndCalls(src, "bash" as unknown as Lang, ".sh", "run.sh");
      const names = out.symbols.map((s) => s.name);
      expect(names).toContain("greet");
      expect(names).toContain("main");
    });
  });

  describe("Lua", () => {
    it("extracts namespace-table, method, local, and assignment function forms", () => {
      const src = `
local T = {}

function T.method(a)
  return a
end

function T:m()
  return self
end

local function helper()
  return 1
end

T.f = function()
  return 2
end

return T
`;
      const out = extractSymbolsAndCalls(src, "lua" as unknown as Lang, ".lua", "init.lua");
      const names = out.symbols.map((s) => s.name);
      const qnames = out.symbols.map((s) => s.qualifiedName);
      expect(names).toContain("<module>");
      // qualified Table.method / T:m() forms resolve to precise method symbols
      expect(qnames).toContain("T.method");
      expect(qnames).toContain("T:m");
      // `local function` keeps its bare name
      expect(names).toContain("helper");
      // `T.f = function() … end` assignment form
      expect(qnames).toContain("T.f");
      const kinds = out.symbols.filter((s) => s.qualifiedName === "T.method").map((s) => s.kind);
      expect(kinds).toContain("method");
      // colon-call form is also a method; the plain local function is not
      expect(out.symbols.find((s) => s.qualifiedName === "T:m")?.kind).toBe("method");
      expect(out.symbols.find((s) => s.qualifiedName === "helper")?.kind).toBe("function");
    });

    it("attributes calls to the enclosing function", () => {
      const src = `
function greet(name)
  return "hi " .. name
end

local function helper()
  return greet("x")
end
`;
      const out = extractSymbolsAndCalls(src, "lua" as unknown as Lang, ".lua", "init.lua");
      expect(out.symbols.some((s) => s.name === "<module>")).toBe(true);
      const greetCall = out.rawCalls.find((c) => c.calleeName === "greet");
      expect(greetCall).toBeDefined();
      expect(greetCall?.callerId).toContain("::helper#");
    });

    it("extracts the `local f = function() … end` assignment form", () => {
      const src = `
local f = function()
  return 1
end

local g = function()
  return f()
end
`;
      const out = extractSymbolsAndCalls(src, "lua" as unknown as Lang, ".lua", "init.lua");
      const names = out.symbols.map((s) => s.name);
      expect(names).toContain("f");
      expect(names).toContain("g");
      expect(out.symbols.find((s) => s.qualifiedName === "f")?.kind).toBe("function");
      // call to `f` lives inside `g`, so it is attributed to `g`
      const fCall = out.rawCalls.find((c) => c.calleeName === "f");
      expect(fCall?.callerId).toContain("::g#");
    });

    it("attributes top-level calls to <module> and resolves dotted callees", () => {
      const src = `
local M = require("mod")

M.setup()

local function run()
  M.start()
end
`;
      const out = extractSymbolsAndCalls(src, "lua" as unknown as Lang, ".lua", "init.lua");
      // calls outside any function fall back to the synthetic <module> scope
      const requireCall = out.rawCalls.find((c) => c.calleeName === "require");
      expect(requireCall?.callerId).toContain("::<module>#");
      // dotted callee `M.setup` resolves to the trailing identifier
      const setupCall = out.rawCalls.find((c) => c.calleeName === "setup");
      expect(setupCall).toBeDefined();
      expect(setupCall?.callerId).toContain("::<module>#");
      // `M.start()` lives inside `run`, so it is attributed there
      const startCall = out.rawCalls.find((c) => c.calleeName === "start");
      expect(startCall?.callerId).toContain("::run#");
    });
  });

  describe("Dart", () => {
    it("extracts type-first declarations the regex fallback could never match", () => {
      const src = `
class Foo {
  Foo(int c);
  Foo.named(int c);
  factory Foo.create() => Foo(1);
  void bar(int x) {
    helper(x);
  }
  String get name => 'foo';
  set name(String v) {}
}

mixin Loggable {
  void log(String msg) {}
}

enum Color { red, green }

extension StrExt on String {
  int len() => length;
}

typedef Callback = void Function(int);

Future<int> fetchCount() async {
  return 1;
}
`;
      const out = extractSymbolsAndCalls(src, "dart" as unknown as Lang, ".dart", "lib/foo.dart");
      const has = (qn: string, kind: string) =>
        out.symbols.some((s) => s.qualifiedName === qn && s.kind === kind);

      expect(has("Foo", "class")).toBe(true);
      // Constructors: plain, named, and factory all resolve as constructors
      // with dotted qualified names — the regex fallback saw none of these.
      // The plain constructor deliberately shares the class's qualified name
      // (that is how call sites reference it); they differ by kind and line.
      expect(has("Foo", "constructor")).toBe(true);
      expect(has("Foo.named", "constructor")).toBe(true);
      expect(has("Foo.create", "constructor")).toBe(true);
      expect(has("Foo.bar", "method")).toBe(true);
      // Getter and setter share a name but live on different lines (distinct ids)
      const nameSyms = out.symbols.filter((s) => s.qualifiedName === "Foo.name");
      expect(nameSyms).toHaveLength(2);
      expect(has("Loggable", "trait")).toBe(true);
      expect(has("Loggable.log", "method")).toBe(true);
      expect(has("Color", "enum")).toBe(true);
      expect(has("StrExt.len", "method")).toBe(true);
      expect(has("Callback", "interface")).toBe(true);
      // Type-first top-level signature (`Future<int> fetchCount()`)
      expect(has("fetchCount", "function")).toBe(true);
    });

    it("stitches a top-level function's scope from its sibling signature and body", () => {
      const src = `
void helper(int x) {
  print(x);
  print(x + 1);
}
`;
      const out = extractSymbolsAndCalls(src, "dart" as unknown as Lang, ".dart", "lib/h.dart");
      const helper = out.symbols.find((s) => s.qualifiedName === "helper");
      // The signature node alone ends on line 2; the scope must reach the
      // body's closing brace, otherwise calls inside attribute to <module>.
      expect(helper?.line).toBe(2);
      expect(helper?.endLine).toBe(5);
      const printCall = out.rawCalls.find((c) => c.calleeName === "print");
      expect(printCall?.callerId).toContain("::helper#");
    });

    it("attributes method calls, cascades, and constructor invocations to the enclosing scope", () => {
      const src = `
class Foo {
  void bar(int x) {}
  Future<void> load() async {}
}

void main() {
  final f = Foo(1);
  f.bar(2);
  f..bar(3)..load();
  mat.runApp();
  helper(5);
}
`;
      const out = extractSymbolsAndCalls(src, "dart" as unknown as Lang, ".dart", "lib/main.dart");
      const fromMain = out.rawCalls.filter((c) => c.callerId.includes("::main#"));
      const callees = fromMain.map((c) => c.calleeName);

      // Constructor invocation (`Foo(1)`, no `new` keyword in modern Dart)
      expect(callees).toContain("Foo");
      // Plain method call `f.bar(2)`
      expect(callees).toContain("bar");
      // Cascade `..load()` — a Dart-only form with its own grammar shape
      expect(callees).toContain("load");
      // Prefixed call `mat.runApp()` resolves to the trailing identifier
      expect(callees).toContain("runApp");
      // Bare call
      expect(callees).toContain("helper");
    });

    it("degrades gracefully on Dart 3.3 extension types (unsupported by grammar 0.0.7)", () => {
      // The vendored tree-sitter grammar predates `extension type` and parses
      // it to ERROR nodes. The contract: no throw, no bogus symbols from the
      // ERROR region, and the rest of the file still extracts normally.
      const src = `
extension type Meters(int value) {
  int get inKm => value ~/ 1000;
}

class Real {
  void work() {}
}
`;
      const out = extractSymbolsAndCalls(src, "dart" as unknown as Lang, ".dart", "lib/m.dart");
      expect(out.symbols.some((s) => s.qualifiedName === "Real" && s.kind === "class")).toBe(true);
      expect(out.symbols.some((s) => s.qualifiedName === "Real.work" && s.kind === "method")).toBe(true);
      // The unsupported declaration produces no symbol named Meters
      expect(out.symbols.some((s) => s.name === "Meters")).toBe(false);
    });

    it("detects main() so Dart apps get a conventional entry point", () => {
      const src = `
void main() {
  runApp();
}
`;
      const out = extractSymbolsAndCalls(src, "dart" as unknown as Lang, ".dart", "bin/app.dart");
      const main = out.symbols.find((s) => s.name === "main");
      expect(main).toBeDefined();
      expect(main?.kind).toBe("function");
    });

    it("extracts abstract bodyless getters, setters, and methods (#74)", () => {
      // Bodyless members parse as `declaration > <signature>` (no function_body),
      // which the original extractor skipped. They are common in Dart interfaces
      // and abstract classes.
      const src = `
abstract class Repo {
  Future<int> load();
  int get count;
  set name(String v);
  void clear() {}
}
`;
      const out = extractSymbolsAndCalls(src, "dart" as unknown as Lang, ".dart", "lib/repo.dart");
      const has = (qn: string, kind: string) =>
        out.symbols.some((s) => s.qualifiedName === qn && s.kind === kind);
      expect(has("Repo", "class")).toBe(true);
      expect(has("Repo.load", "method")).toBe(true); // abstract method
      expect(has("Repo.count", "method")).toBe(true); // abstract getter
      expect(has("Repo.name", "method")).toBe(true); // abstract setter
      expect(has("Repo.clear", "method")).toBe(true); // concrete method still works
    });

    it("extracts operators (with and without a body), named by their token (#74)", () => {
      // Operators are not named by an identifier; the symbol is `operator<token>`.
      const src = `
class Vec {
  Vec operator +(Vec o) => o;
  bool operator ==(Object o) => true;
  num operator [](int i) => i;
  Vec operator -(Vec o);
}
`;
      const out = extractSymbolsAndCalls(src, "dart" as unknown as Lang, ".dart", "lib/vec.dart");
      const qns = out.symbols.map((s) => s.qualifiedName);
      expect(qns).toContain("Vec.operator+"); // binary, with body
      expect(qns).toContain("Vec.operator=="); // equality, with body
      expect(qns).toContain("Vec.operator[]"); // index, with body
      expect(qns).toContain("Vec.operator-"); // abstract (bodyless) operator
      for (const s of out.symbols) {
        if (s.qualifiedName.startsWith("Vec.operator")) expect(s.kind).toBe("method");
      }
    });

    it("does not regress fields, constructors, or getters-with-body (#74)", () => {
      // The new abstract-member handling must not change anything that already
      // worked, and must keep skipping plain fields.
      const src = `
class Foo {
  int count = 0;
  Foo(this.count);
  factory Foo.create() => Foo(0);
  String get label => "x";
}
`;
      const out = extractSymbolsAndCalls(src, "dart" as unknown as Lang, ".dart", "lib/foo.dart");
      const has = (qn: string, kind: string) =>
        out.symbols.some((s) => s.qualifiedName === qn && s.kind === kind);
      expect(has("Foo", "class")).toBe(true);
      expect(has("Foo.create", "constructor")).toBe(true);
      expect(has("Foo.label", "method")).toBe(true); // getter with body
      // Field `count` is not callable and must NOT become a symbol.
      expect(out.symbols.some((s) => s.qualifiedName === "Foo.count")).toBe(false);
    });

    it("recovers sibling classes when an unparseable sealed class is present (#74)", () => {
      // sealed class is Dart 3 syntax the grammar cannot parse. It is lost, but
      // the regular classes and enums around it must still be extracted, not
      // zeroed out. This pins the partial-degradation behavior.
      const src = `
class Before { void a() {} }

sealed class Sealed { int get id; }

class After { void b() {} }

enum Color { red, green }
`;
      const out = extractSymbolsAndCalls(src, "dart" as unknown as Lang, ".dart", "lib/mixed.dart");
      expect(out.symbols.some((s) => s.qualifiedName === "Before" && s.kind === "class")).toBe(true);
      expect(out.symbols.some((s) => s.qualifiedName === "Before.a" && s.kind === "method")).toBe(true);
      expect(out.symbols.some((s) => s.qualifiedName === "After" && s.kind === "class")).toBe(true);
      expect(out.symbols.some((s) => s.qualifiedName === "After.b" && s.kind === "method")).toBe(true);
      expect(out.symbols.some((s) => s.qualifiedName === "Color" && s.kind === "enum")).toBe(true);
      // The sealed class itself cannot be parsed by this grammar version.
      expect(out.symbols.some((s) => s.qualifiedName === "Sealed")).toBe(false);
    });

    it("warns once (not per file) when Dart files contain unparseable syntax (#74)", () => {
      resetSymbolExtractionWarnings();
      const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
      try {
        const sealed = "sealed class A { int get id; }\n";
        extractSymbolsAndCalls(sealed, "dart" as unknown as Lang, ".dart", "lib/a.dart");
        extractSymbolsAndCalls(sealed, "dart" as unknown as Lang, ".dart", "lib/b.dart");
        const dartWarns = warnSpy.mock.calls.filter(([msg]) =>
          typeof msg === "string" && msg.includes("@ast-grep/lang-dart"),
        );
        // Two files with errors, but the process-level dedup emits exactly one warn.
        expect(dartWarns).toHaveLength(1);
      } finally {
        warnSpy.mockRestore();
        resetSymbolExtractionWarnings();
      }
    });
  });

  describe("Destructuring & Call Provenance", () => {
    it("extracts only left binding from object_assignment_pattern, ignoring default value expression", () => {
      const src = `
export const { port = getDefaultPort(), host: serverHost = "localhost" } = config;
`;
      const out = extractSymbolsAndCalls(src, Lang.TypeScript, ".ts", "src/config.ts");
      const names = out.symbols.map((s) => s.name);
      expect(names).toContain("port");
      expect(names).toContain("serverHost");
      expect(names).not.toContain("getDefaultPort");
      expect(names).not.toContain("config");
    });

    it("does not classify an object binding as a function because its initializer contains one", () => {
      const src = `
export const config = { handler: () => "ok" };
export const direct = () => "ok";
`;
      const out = extractSymbolsAndCalls(src, Lang.TypeScript, ".ts", "src/config.ts");
      expect(out.symbols.find((symbol) => symbol.name === "config")?.kind).toBe("variable");
      expect(out.symbols.find((symbol) => symbol.name === "direct")?.kind).toBe("function");
    });

    it("does not attach bare import provenance to member method calls", () => {
      const src = `
import { run } from "./runner";
export function main(obj: any): void {
  obj.run();
  run();
}
`;
      const out = extractSymbolsAndCalls(src, Lang.TypeScript, ".ts", "src/app.ts");
      const runCalls = out.rawCalls.filter((c) => c.kind === "call" && c.calleeName === "run");
      expect(runCalls).toHaveLength(2);

      const memberCall = runCalls.find((c) => c.callSite.line === 4);
      expect(memberCall).toBeDefined();
      expect(memberCall?.sourceModule).toBeUndefined();
      expect(memberCall?.importedName).toBeUndefined();

      const bareCall = runCalls.find((c) => c.callSite.line === 5);
      expect(bareCall).toBeDefined();
      expect(bareCall?.sourceModule).toBe("./runner");
      expect(bareCall?.importedName).toBe("run");
    });

    it("extracts namespace re-export with export * as ns from './dep'", () => {
      const src = `
export * as utils from "./utils";
`;
      const out = extractSymbolsAndCalls(src, Lang.TypeScript, ".ts", "src/index.ts");
      const reexport = out.rawCalls.find((c) => c.kind === "reexport");
      expect(reexport).toBeDefined();
      expect(reexport?.calleeName).toBe("utils");
      expect(reexport?.localAlias).toBe("utils");
      expect(reexport?.sourceModule).toBe("./utils");
      expect(reexport?.importedName).toBeUndefined();
    });

    it("does not emit self-referential value_reference for locally exported declaration lines", () => {
      const src = `
export function computeTotal(a: number, b: number): number {
  return a + b;
}
export { computeTotal };
`;
      const out = extractSymbolsAndCalls(src, Lang.TypeScript, ".ts", "src/math.ts");
      const valueRefs = out.rawCalls.filter((c) => c.kind === "value_reference" && c.calleeName === "computeTotal");
      expect(valueRefs).toHaveLength(0);
    });

    it("marks only the module-scope binding named by a local export specifier", () => {
      const src = `
function outer() {
  function Thing() {}
}
function Thing() {}
export { Thing as PublicThing };
`;
      const out = extractSymbolsAndCalls(src, Lang.TypeScript, ".ts", "src/things.ts");
      const things = out.symbols.filter((symbol) => symbol.name === "Thing");
      expect(things).toHaveLength(2);

      const exported = things.filter((symbol) => symbol.isExported);
      expect(exported).toHaveLength(1);
      expect(exported[0]).toMatchObject({ line: 5, exportedAs: "PublicThing" });
      expect(things.find((symbol) => symbol.line === 3)?.isExported).toBe(false);
    });

    it("skips non-computed member properties and shadowed parameters", () => {
      const src = `
import { config, run } from "./lib";

function execute(config: string) {
  const result = obj.run;
  console.log(config);
}

const direct = run();
`;
      const out = extractSymbolsAndCalls(src, Lang.TypeScript, ".ts", "src/caller.ts");
      // obj.run is a member property, not a value reference to imported run
      const runRefs = out.rawCalls.filter((c) => c.calleeName === "run" && c.kind === "value_reference");
      expect(runRefs).toHaveLength(0);
      // config inside execute is shadowed by parameter `config: string`
      const configRefs = out.rawCalls.filter((c) => c.calleeName === "config" && c.kind === "value_reference");
      expect(configRefs).toHaveLength(0);
      // direct call to run() is preserved as call
      const runCalls = out.rawCalls.filter((c) => c.calleeName === "run" && c.kind === "call");
      expect(runCalls).toHaveLength(1);
    });

    it("shadows imported references when local variable, destructuring, or catch binding exists", () => {
      const src = `
import { config, logger, error } from "./lib";

function run() {
  const config = loadLocal();
  const { logger } = getContext();
  try {
    doWork(config, logger);
  } catch (error) {
    handle(error);
  }
}
`;
      const out = extractSymbolsAndCalls(src, Lang.TypeScript, ".ts", "src/shadow.ts");
      const configRefs = out.rawCalls.filter((c) => c.calleeName === "config" && c.kind === "value_reference");
      const loggerRefs = out.rawCalls.filter((c) => c.calleeName === "logger" && c.kind === "value_reference");
      const errorRefs = out.rawCalls.filter((c) => c.calleeName === "error" && c.kind === "value_reference");
      expect(configRefs).toHaveLength(0);
      expect(loggerRefs).toHaveLength(0);
      expect(errorRefs).toHaveLength(0);
    });

    it("does not suppress imported reference outside a nested block scope", () => {
      const src = `
import { data } from "./data";

function process(condition: boolean) {
  if (condition) {
    const data = "local";
    console.log(data);
  }
  return data;
}
`;
      const out = extractSymbolsAndCalls(src, Lang.TypeScript, ".ts", "src/block-scope.ts");
      const dataRefs = out.rawCalls.filter((c) => c.calleeName === "data" && c.kind === "value_reference");
      // Outside the if-block, `return data` must emit an imported value_reference
      expect(dataRefs).toHaveLength(1);
      expect(dataRefs[0].callSite.line).toBe(9);
      expect(dataRefs[0].sourceModule).toBe("./data");
    });

    it("does not let a nested function's var shadow an outer imported reference", () => {
      const src = `
import { dep } from "./dep";

function outer() {
  function inner() { var dep = 1; return dep; }
  return dep;
}
`;
      const out = extractSymbolsAndCalls(src, Lang.TypeScript, ".ts", "src/nested-var.ts");
      const depRefs = out.rawCalls.filter(
        (call) => call.calleeName === "dep" && call.kind === "value_reference",
      );
      expect(depRefs).toHaveLength(1);
      expect(depRefs[0].callSite.line).toBe(6);
      expect(depRefs[0].sourceModule).toBe("./dep");
      expect(depRefs[0].callerId).toContain("::outer#");
    });
  });
});
