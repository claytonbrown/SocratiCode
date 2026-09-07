// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

import { Lang } from "@ast-grep/napi";
import { beforeAll, describe, expect, it } from "vitest";
import { ensureDynamicLanguages } from "../../src/services/code-graph.js";
import { extractImports } from "../../src/services/graph-imports.js";

// Register dynamic language grammars once before all tests
beforeAll(() => {
  ensureDynamicLanguages();
});

describe("graph-imports", () => {
  // ── TypeScript / JavaScript ────────────────────────────────────────────

  describe("TypeScript/JavaScript imports", () => {
    it("extracts static imports", () => {
      const source = `
import { foo } from "./utils.js";
import bar from "../lib/bar.js";
import * as helpers from "./helpers.js";
`;
      const imports = extractImports(source, Lang.TypeScript, ".ts");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs).toContain("./utils.js");
      expect(specs).toContain("../lib/bar.js");
      expect(specs).toContain("./helpers.js");
    });

    it("extracts dynamic imports", () => {
      const source = `
const mod = await import("./dynamic-module.js");
`;
      const imports = extractImports(source, Lang.TypeScript, ".ts");
      const dynamicImports = imports.filter((i) => i.isDynamic);

      expect(dynamicImports.length).toBeGreaterThanOrEqual(1);
      expect(
        dynamicImports.some((i) => i.moduleSpecifier === "./dynamic-module.js"),
      ).toBe(true);
    });

    it("extracts require() calls", () => {
      const source = `
const fs = require("fs");
const local = require("./local-module");
`;
      const imports = extractImports(source, Lang.JavaScript, ".js");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs).toContain("fs");
      expect(specs).toContain("./local-module");
    });

    it("extracts re-exports", () => {
      const source = `
export { default } from "./base.js";
export * from "./all.js";
`;
      const imports = extractImports(source, Lang.TypeScript, ".ts");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs).toContain("./base.js");
      expect(specs).toContain("./all.js");
    });

    it("handles empty source", () => {
      const imports = extractImports("", Lang.TypeScript, ".ts");
      expect(imports).toHaveLength(0);
    });

    it("handles source with no imports", () => {
      const source = `
function hello() {
  return "world";
}
`;
      const imports = extractImports(source, Lang.TypeScript, ".ts");
      expect(imports).toHaveLength(0);
    });
  });

  // ── Svelte ──────────────────────────────────────────────────────────────

  describe("Svelte imports", () => {
    it("extracts imports from <script> blocks", () => {
      const source = `
<script lang="ts">
  import { onMount } from "svelte";
  import Button from "./Button.svelte";
  import { type Props } from "../types.js";
</script>

<Button>Click me</Button>
`;
      const imports = extractImports(source, "svelte", ".svelte");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs).toContain("svelte");
      expect(specs).toContain("./Button.svelte");
      expect(specs).toContain("../types.js");
    });

    it("extracts imports from <script module> blocks", () => {
      const source = `
<script lang="ts" module>
  export type Variant = "primary" | "secondary";
  export { default as Button } from "./Button.svelte";
</script>

<script lang="ts">
  import { onMount } from "svelte";
</script>

<div>content</div>
`;
      const imports = extractImports(source, "svelte", ".svelte");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs).toContain("./Button.svelte");
      expect(specs).toContain("svelte");
    });

    it("extracts dynamic imports from Svelte files", () => {
      const source = `
<script lang="ts">
  const Component = await import("./DynamicComponent.svelte");
</script>
`;
      const imports = extractImports(source, "svelte", ".svelte");
      const dynamicImports = imports.filter((i) => i.isDynamic);

      expect(dynamicImports.length).toBeGreaterThanOrEqual(1);
      expect(
        dynamicImports.some(
          (i) => i.moduleSpecifier === "./DynamicComponent.svelte",
        ),
      ).toBe(true);
    });

    it("handles Svelte files with no script block", () => {
      const source = `
<div>Just markup, no script</div>
<style>
  div { color: red; }
</style>
`;
      const imports = extractImports(source, "svelte", ".svelte");
      expect(imports).toHaveLength(0);
    });

    it("handles Svelte files with JavaScript (no lang=ts)", () => {
      const source = `
<script>
  import { writable } from "svelte/store";
  import Item from "./Item.svelte";
</script>
`;
      const imports = extractImports(source, "svelte", ".svelte");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs).toContain("svelte/store");
      expect(specs).toContain("./Item.svelte");
    });
  });

  // ── Vue ────────────────────────────────────────────────────────────────

  describe("Vue imports", () => {
    it("extracts imports from <script> blocks", () => {
      const source = `
<script lang="ts">
  import { ref, computed } from "vue";
  import MyComponent from "./MyComponent.vue";
</script>

<template>
  <MyComponent />
</template>
`;
      const imports = extractImports(source, "vue", ".vue");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs).toContain("vue");
      expect(specs).toContain("./MyComponent.vue");
    });
  });

  // ── CSS @import in Svelte/Vue <style> blocks ────────────────────────────

  describe("CSS @import in Svelte style blocks", () => {
    it("extracts @import from <style> block", () => {
      const source = `
<script lang="ts">
  import { onMount } from "svelte";
</script>

<style>
  @import "./variables.css";
  @import "../mixins.scss";
</style>
`;
      const imports = extractImports(source, "svelte", ".svelte");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs).toContain("svelte");
      expect(specs).toContain("./variables.css");
      expect(specs).toContain("../mixins.scss");
    });

    it("extracts @import url(...) variant", () => {
      const source = `
<style>
  @import url("./theme.css");
</style>
`;
      const imports = extractImports(source, "svelte", ".svelte");
      expect(imports.some((i) => i.moduleSpecifier === "./theme.css")).toBe(true);
    });

    it("skips external URLs", () => {
      const source = `
<style>
  @import "https://fonts.googleapis.com/css2?family=Inter";
  @import "./local.css";
</style>
`;
      const imports = extractImports(source, "svelte", ".svelte");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs).not.toContain("https://fonts.googleapis.com/css2?family=Inter");
      expect(specs).toContain("./local.css");
    });

    it("extracts @import from <style global>", () => {
      const source = `
<style global>
  @import "./global-reset.css";
</style>
`;
      const imports = extractImports(source, "svelte", ".svelte");
      expect(imports.some((i) => i.moduleSpecifier === "./global-reset.css")).toBe(true);
    });

    it("marks CSS imports with isCssImport flag", () => {
      const source = `
<script lang="ts">
  import { onMount } from "svelte";
</script>

<style>
  @import "./variables.css";
</style>
`;
      const imports = extractImports(source, "svelte", ".svelte");
      const jsImport = imports.find((i) => i.moduleSpecifier === "svelte");
      const cssImport = imports.find((i) => i.moduleSpecifier === "./variables.css");

      expect(jsImport?.isCssImport).toBeFalsy();
      expect(cssImport?.isCssImport).toBe(true);
    });

    it("handles no style block", () => {
      const source = `
<script>
  import { writable } from "svelte/store";
</script>
<div>content</div>
`;
      const imports = extractImports(source, "svelte", ".svelte");
      // Should only have script imports, no CSS imports
      expect(imports).toHaveLength(1);
      expect(imports[0].moduleSpecifier).toBe("svelte/store");
    });
  });

  describe("CSS @import in Vue style blocks", () => {
    it("extracts @import from <style> block", () => {
      const source = `
<script lang="ts">
  import { ref } from "vue";
</script>

<template>
  <div>content</div>
</template>

<style scoped>
  @import "./component.css";
</style>
`;
      const imports = extractImports(source, "vue", ".vue");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs).toContain("vue");
      expect(specs).toContain("./component.css");
    });

    it("extracts @import url(...) from Vue style", () => {
      const source = `
<style>
  @import url("./variables.scss");
  @import url('./mixins.css');
</style>
`;
      const imports = extractImports(source, "vue", ".vue");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs).toContain("./variables.scss");
      expect(specs).toContain("./mixins.css");
    });

    it("extracts @import from all style tag variants (scoped, module, lang)", () => {
      const source = `
<script lang="ts">
  import { ref } from "vue";
</script>

<template><div /></template>

<style lang="scss" scoped>
  @import "./scoped-scss.scss";
</style>

<style module>
  @import "./module.css";
</style>

<style lang="less">
  @import "./theme.less";
</style>
`;
      const imports = extractImports(source, "vue", ".vue");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs).toContain("vue");
      expect(specs).toContain("./scoped-scss.scss");
      expect(specs).toContain("./module.css");
      expect(specs).toContain("./theme.less");
    });
  });

  // ── Stylus @require in style blocks ──────────────────────────────────────

  describe("Stylus @require in style blocks", () => {
    it("extracts @require from Svelte <style lang=\"stylus\">", () => {
      const source = `
<script>
  import App from "./App.svelte";
</script>

<style lang="stylus">
  @require "./variables.styl"
  @require "../mixins.styl"
</style>
`;
      const imports = extractImports(source, "svelte", ".svelte");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs).toContain("./variables.styl");
      expect(specs).toContain("../mixins.styl");
    });

    it("extracts @import and @require from Vue <style lang=\"stylus\">", () => {
      const source = `
<template><div /></template>

<style lang="stylus">
  @import "./base.styl"
  @require "./theme.styl"
</style>
`;
      const imports = extractImports(source, "vue", ".vue");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs).toContain("./base.styl");
      expect(specs).toContain("./theme.styl");
    });
  });

  // ── Standalone CSS ──────────────────────────────────────────────────────

  describe("Standalone CSS imports", () => {
    it("extracts @import from CSS files", () => {
      const source = `
@import "./variables.css";
@import url("./mixins.css");

body { color: red; }
`;
      const imports = extractImports(source, Lang.Css, ".css");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs).toContain("./variables.css");
      expect(specs).toContain("./mixins.css");
    });

    it("skips external URLs in CSS files", () => {
      const source = `
@import "https://cdn.example.com/reset.css";
@import "./local.css";
`;
      const imports = extractImports(source, Lang.Css, ".css");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs).not.toContain("https://cdn.example.com/reset.css");
      expect(specs).toContain("./local.css");
    });
  });

  // ── Python ─────────────────────────────────────────────────────────────

  describe("Python imports", () => {
    it("extracts import statements", () => {
      const source = `
import os
import json
from typing import List, Dict
from .models import User
from ..utils import helpers
`;
      const imports = extractImports(source, "python", ".py");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs).toContain("os");
      expect(specs).toContain("json");
      expect(specs).toContain("typing");
      expect(specs).toContain(".models");
      expect(specs).toContain("..utils");
    });
  });

  // ── Java ───────────────────────────────────────────────────────────────

  describe("Java imports", () => {
    it("extracts import declarations", () => {
      const source = `
package com.example;

import java.util.List;
import com.example.models.User;
import static java.lang.Math.PI;
`;
      const imports = extractImports(source, "java", ".java");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs.length).toBeGreaterThan(0);
      // Should capture the import paths
      expect(specs.some((s) => s.includes("java.util"))).toBe(true);
    });
  });

  // ── Rust ───────────────────────────────────────────────────────────────

  describe("Rust imports", () => {
    const specsOf = (source: string): string[] =>
      extractImports(source, "rust", ".rs").map((i) => i.moduleSpecifier);

    it("extracts use statements", () => {
      const source = `
use std::collections::HashMap;
use crate::models::User;
mod config;
`;
      const imports = extractImports(source, "rust", ".rs");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs.length).toBeGreaterThan(0);
    });

    it("extracts module declarations behind a visibility modifier", () => {
      const specs = specsOf(`
mod private_one;
pub mod public_one;
pub(crate) mod crate_visible;
pub(in crate::outer) mod scoped;
`);

      expect(specs).toEqual(["private_one", "public_one", "crate_visible", "scoped"]);
    });

    it("extracts re-exports", () => {
      const specs = specsOf(`
pub use crate::config::Config;
pub(crate) use crate::db::Pool;
`);

      expect(specs).toEqual(["crate::config::Config", "crate::db::Pool"]);
    });

    it("still skips inline module definitions", () => {
      const specs = specsOf(`
pub mod inline {
    pub fn thing() {}
}
mod declared;
`);

      expect(specs).toEqual(["declared"]);
    });

    it("expands a use group into one path per leaf", () => {
      const specs = specsOf("use crate::{parser, printer::Printer};");

      expect(specs).toEqual(["crate::parser", "crate::printer::Printer"]);
    });

    it("expands nested use groups", () => {
      const specs = specsOf("use crate::{a::{b, c}, d};");

      expect(specs).toEqual(["crate::a::b", "crate::a::c", "crate::d"]);
    });

    it("reads self and glob leaves as the module they name", () => {
      const specs = specsOf(`
use crate::config::{self, Config};
use crate::helpers::*;
`);

      expect(specs).toEqual(["crate::config", "crate::config::Config", "crate::helpers"]);
    });

    it("drops the alias from a renamed import", () => {
      const specs = specsOf("use crate::models::User as DomainUser;");

      expect(specs).toEqual(["crate::models::User"]);
    });

    it("reads a use declaration split across lines", () => {
      const specs = specsOf(`
use crate::{
    alpha,
    beta::Gamma,
};
`);

      expect(specs).toEqual(["crate::alpha", "crate::beta::Gamma"]);
    });

    it("keeps the module a group leaf names when that leaf is renamed", () => {
      const specs = specsOf(`
use crate::config::{self as cfg, Config};
use crate::helpers::{* };
`);

      // `{self as cfg}` names the same module `{self}` does; comparing the
      // leaf before removing the alias dropped the import altogether.
      expect(specs).toEqual(["crate::config", "crate::config::Config", "crate::helpers"]);
    });

    it("keeps the leading :: that says the head is a crate", () => {
      const specs = specsOf(`
use ::config::Item;
use ::serde::{Serialize, Deserialize};
`);

      expect(specs).toEqual(["::config::Item", "::serde::Serialize", "::serde::Deserialize"]);
    });

    it("keeps the leading :: when the group opens on it", () => {
      // `::{…}` carries the marker in the group prefix and nowhere else.
      // Stripping the trailing `::` left the empty string, which reads the same
      // as a group with no prefix, and the path resolved into the local module
      // again — the capture the marker exists to prevent.
      const specs = specsOf(`
use ::{corelib::marker};
use ::{corelib::marker, log::Level};
`);

      expect(specs).toEqual([
        "::corelib::marker",
        "::corelib::marker",
        "::log::Level",
      ]);
    });

    it("leaves a group with no prefix alone", () => {
      // The guard above must not turn every prefix-less group into a global
      // path: `use {a, b};` names two paths in the file's own scope.
      const specs = specsOf("use {alpha, beta::Gamma};");

      expect(specs).toEqual(["alpha", "beta::Gamma"]);
    });

    it("finds a path attribute with a comment between it and the mod", () => {
      const specs = specsOf(`
#[path = "elsewhere/moved.rs"]
// kept here because the generator writes it there
mod moved;
`);

      expect(specs).toEqual(["elsewhere/moved.rs"]);
    });

    it("ignores comments written between the leaves of a use group", () => {
      const specs = specsOf(`
use crate::{
    // the one we need
    models::User,
    /* and this one */ helpers::format,
};
`);

      expect(specs).toEqual(["crate::models::User", "crate::helpers::format"]);
    });

    it("names the module a raw identifier escapes, not its escape", () => {
      const specs = specsOf(`
pub mod r#async;
use crate::r#type::Kind;
use crate::r#match::Pattern as r#final;
`);

      // `use` declarations are read before `mod` ones, hence the order.
      expect(specs).toEqual(["crate::type::Kind", "crate::match::Pattern", "async"]);
    });

    it("takes the file of a mod from its path attribute", () => {
      const specs = specsOf(`
#[path = "elsewhere/moved.rs"]
mod moved;
#[cfg(test)]
#[path = "fixtures/support.rs"]
mod support;
mod conventional;
`);

      expect(specs).toEqual(["elsewhere/moved.rs", "fixtures/support.rs", "conventional"]);
    });

    it("takes the file of a mod from a cfg_attr path attribute", () => {
      // The platform-abstraction idiom, and the Rust Reference's own example:
      // the module `sys` is `unix.rs` here and `windows.rs` there, and
      // `src/sys.rs` is never read. Reading only the bare form both drew an
      // edge to that unread file and missed the one carrying the crate body.
      //
      // One path per named file, because the graph does not fix a target or a
      // feature set — the same reading `#[cfg(…)] mod` already gets.
      //
      // Nearest the `mod` first: the attributes are walked backwards from it,
      // which is where a lone `#[path]` was already read from.
      //
      // The plain name closes the list, because a `cfg_attr` applies only where
      // its condition holds and where none does the module is the file its name
      // implies — `errno`'s own `src/sys.rs` is written for exactly that case.
      const specs = specsOf(`
#[cfg_attr(unix, path = "unix.rs")]
#[cfg_attr(windows, path = "windows.rs")]
mod sys;
`);

      expect(specs).toEqual(["windows.rs", "unix.rs", "sys"]);
    });

    it("reads the declarations written inside a macro invocation", () => {
      // tree-sitter keeps a macro body as an unparsed token tree, so nothing in
      // it was a node and half of tokio's `mod` declarations — 256 of 535 —
      // were invisible, along with 348 `use`. Expansion happens before name
      // resolution: what is written in there is a declaration like any other.
      const specs = specsOf(`
mod plain;

cfg_io_util! {
    mod async_buf_read_ext;
    pub use async_buf_read_ext::AsyncBufReadExt;

    mod buf_reader;
}
`);

      expect(specs).toContain("plain");
      expect(specs).toContain("async_buf_read_ext");
      expect(specs).toContain("buf_reader");
      expect(specs).toContain("async_buf_read_ext::AsyncBufReadExt");
    });

    it("does not read a macro body as a module level of its own", () => {
      // The body is unwrapped in place, so what encloses it still counts and
      // the macro itself does not: `mod x;` inside `cfg_windows! { … }` written
      // in `mod inner { … }` names `inner/x`, not `cfg_windows/x` and not `x`.
      const specs = specsOf(`
mod inner {
    cfg_windows! {
        mod named_pipe;
    }
}
`);

      expect(specs).toEqual(["self::inner::named_pipe"]);
    });

    it("reads a #[path] declaration written inside a macro invocation", () => {
      // tokio's `atomic_u64.rs` writes exactly this, twice: the module is
      // always `imp`, and only the attribute says which file it is.
      const specs = specsOf(`
cfg_has_atomic_u64! {
    #[path = "atomic_u64_native.rs"]
    mod imp;
}

cfg_not_has_atomic_u64! {
    #[path = "atomic_u64_as_mutex.rs"]
    mod imp;
}
`);

      expect(specs).toEqual(["atomic_u64_native.rs", "atomic_u64_as_mutex.rs"]);
    });

    it("does not read a macro body written as an expression", () => {
      // A proc-macro's `quote! { … }` builds the tokens its *caller* will get:
      // the module is declared there, not here. Checked on cargo 1.98.0 with a
      // `compile_error!` in `src/generated.rs` — the crate builds clean and its
      // dep-info names `src/lib.rs` alone, while the graph had drawn the file
      // as a dependency, twice.
      //
      // The rule is read off the tree, not off the macro's name: a body holds
      // items only where the invocation itself may be one. Both spellings are
      // checked, the method receiver and the tail expression — the second is
      // the idiom of every `fn … -> TokenStream`, and it is the reason a block
      // does not count as an item position.
      for (const body of [
        "    quote! {\n        mod generated;\n        pub use generated::Thing;\n    }\n    .into()",
        "    quote! {\n        mod generated;\n        pub use generated::Thing;\n    }",
      ]) {
        const specs = specsOf(`
use quote::quote;

pub fn emit() -> TokenStream {
${body}
}
`);

        expect(specs, `body: ${body}`).not.toContain("generated");
        expect(specs, `body: ${body}`).not.toContain("generated::Thing");
      }
    });

    it("reads a macro body written where an item may stand", () => {
      // The other side of the same rule, in the two places that count: the file
      // itself and a `mod` body. An `impl` body counts too — tokio writes a
      // `cfg_unstable! { fn … { use …; } }` in one.
      const specs = specsOf(`
cfg_a! {
    mod at_file;
}

mod holder {
    cfg_b! {
        mod in_mod;
    }
}

impl Thing {
    cfg_c! {
        fn f() { use crate::in_impl::Marker; }
    }
}
`);

      expect(specs).toContain("at_file");
      expect(specs).toContain("self::holder::in_mod");
      expect(specs).toContain("crate::in_impl::Marker");
    });

    it("still reads a body the parser recovers from without leaving it", () => {
      // The complement of the test below, and the reason the guard is drawn
      // around where recovery reaches rather than around the ERROR node.
      // `cfg_if!` at file level leaves an ERROR on the attribute and moves
      // nothing: the declarations in the arms are read where they were written,
      // which is where rustc reads them too.
      //
      // Refusing every body that does not parse as items on its own would cost
      // this case: 449 macro bodies carrying declarations across a 1,256-crate
      // registry cache do not, and 431 of them stand at file level. `js-sys`,
      // `backtrace`, `ahash` and `aes` each lose real module edges that way.
      const specs = specsOf(`
cfg_if! {
    if #[cfg(unix)] {
        mod arm_a;
        pub use arm_a::Thing;
    } else {
        mod arm_b;
    }
}

mod after;
`);

      expect(specs).toContain("arm_a");
      expect(specs).toContain("arm_b");
      expect(specs).toContain("arm_a::Thing");
      expect(specs).toContain("after");
    });

    it("reads a macro nested inside one, beside a body the parser recovers from", () => {
      // The second unwrap pass reads a source the first one rewrote, so the
      // ERROR a kept `cfg_if!` leaves behind is in its input. Counting that
      // against the pass cost `deep` its edge — a macro one level further in,
      // with nothing wrong with it, punished for its neighbour.
      const specs = specsOf(`
cfg_if! {
    if #[cfg(unix)] {
        mod arm_a;
    } else {
        mod arm_b;
    }
}

outer! {
    inner! {
        mod deep;
    }
}
`);

      expect(specs).toContain("deep");
      expect(specs).toContain("arm_a");
    });

    it("leaves a body alone when recovery reaches past the macro", () => {
      // `cfg_if!` writes its arms as `if #[cfg(…)] { … } else { … }`, and an
      // `if` carrying an attribute is not Rust anywhere. Blanking the head and
      // the outer braces hands the parser a fragment it recovers from, and
      // recovery does not stop at the macro: the enclosing `mod` is closed
      // after the first arm and what follows is re-parented to file level.
      //
      // Cargo-verified: a crate with this shape builds clean while the graph
      // drew `src/lib.rs -> src/arm_b.rs` twice and `src/lib.rs -> src/dopo.rs`
      // — three edges into files carrying `compile_error!`, one of them a
      // module that belongs to the block.
      //
      // `cfg_io_util!` is the control. Without it an assertion about what is
      // missing would also pass with body reading turned off entirely.
      const specs = specsOf(`
cfg_io_util! {
    mod control;
}

mod inner {
    mod before;
    cfg_if! {
        if #[cfg(unix)] {
            mod arm_a;
        } else if #[cfg(windows)] {
            mod arm_b;
        } else {
            mod arm_c;
        }
    }
    mod after;
}
`);

      expect(specs).toContain("control");
      expect(specs).toContain("self::inner::before");
      expect(specs).toContain("self::inner::after");
      // Not at file level, and not anywhere: the arms stay unread.
      expect(specs).not.toContain("after");
      expect(specs.filter((s) => s.includes("arm_"))).toEqual([]);
    });

    it("gives up only the macro that let recovery out, not the file it is in", () => {
      // The retry that saves the rest of the file, and nothing was holding it:
      // a mutation pass found that pinning `insideBlock` to either value left
      // the whole suite green. What it costs is measurable — the narrow retry
      // is worth 22 distinct dependencies across the 153 crates of a registry
      // cache that carry the shape, ahash and dashmap among them, where one
      // `cfg_if!` written in an `impl` used to take every file-level one with
      // it.
      //
      // Three macros in one file is what it takes to see: a clean one, an
      // unparsable one at file level, and an unparsable one inside a block.
      // Only the last is given up.
      const specs = specsOf(`
cfg_clean! {
    mod clean_mod;
}

cfg_if! {
    if #[cfg(unix)] {
        mod file_arm_a;
    } else {
        mod file_arm_b;
    }
}

mod inner {
    mod before;
    cfg_if! {
        if #[cfg(unix)] {
            mod arm_a;
        } else {
            mod arm_b;
        }
    }
    mod after;
}
`);

      expect(specs).toContain("clean_mod");
      expect(specs).toContain("file_arm_a");
      expect(specs).toContain("file_arm_b");
      // The block keeps its own declarations, and the arms inside it stay unread.
      expect(specs).toContain("self::inner::before");
      expect(specs).toContain("self::inner::after");
      expect(specs.filter((s) => s.includes("arm_a") && !s.startsWith("file_"))).toEqual([]);
    });

    it("leaves the body alone when the file was already failing to parse", () => {
      // The way back into the defect, found by trying to get around the guard:
      // if the ERROR nodes a source already had were forgiven, a file carrying
      // an unresolved merge marker inside the block would have one at the same
      // index recovery produces — and the damaged pass came back, with
      // `mod after;` drawn at file level, where rustc never looks for it.
      //
      // So nothing is forgiven but the macros actually unwrapped, and a source
      // broken for its own reasons gets no unwrapping at all.
      const specs = specsOf(`
mod inner {
    mod before;
    cfg_if! {
        if #[cfg(unix)] {
            mod arm_a;
        } else {
            mod arm_b;
        }
    }
    mod after;
<<<<<<< HEAD
}
`);

      expect(specs).toContain("self::inner::before");
      expect(specs).not.toContain("after");
      expect(specs.filter((s) => s.includes("arm_"))).toEqual([]);
    });

    it("does not let a macro accepted on the first pass forgive what the second one breaks", () => {
      // Found by review. `outer!` wraps items and is accepted whole on the
      // first pass, with no ERROR anywhere. On the second pass the `cfg_if!`
      // inside `mod k` closes the block early — the same damage the guard was
      // written for — but the orphan `}` that should reject the pass now lies
      // inside `outer!`'s own region. Forgiving everything inside a macro an
      // earlier pass unwrapped accepted it, and `mod z;` was drawn at file
      // level again, where rustc never looks for it.
      //
      // What an earlier pass hands on is therefore the exact ERRORs its tree
      // had, and this file has none to hand on.
      const specs = specsOf(`
outer! {
    mod k {
        mod before;
        cfg_if! {
            if #[cfg(unix)] {
                mod arm_a;
            } else {
                mod arm_b;
            }
        }
        mod z;
    }
}
`);

      expect(specs).toContain("self::k::before");
      expect(specs).toContain("self::k::z");
      expect(specs).not.toContain("z");
      expect(specs.filter((s) => s.includes("arm_"))).toEqual([]);
    });

    it("keeps the second pass's reading of a line the first pass read with less in view", () => {
      // Found by review. On the first pass the glob is hidden in `cfg_test!`'s
      // token tree, so `outer::Thing` is a bare head in a block with nothing
      // anchoring it; the second pass sees the glob and reads the same line as
      // a path the block may answer. Keyed on that flag, both readings were
      // kept — and the first, resolved with no declarations in scope, could
      // reach a workspace crate named `outer` that rustc refuses with E0432.
      const imports = extractImports(
        `
mod outer;

#[cfg(test)]
mod tests {
    cfg_test! {
        use super::*;
    }
    use outer::Thing;
}
`,
        "rust",
        ".rs",
      ).filter((i) => i.moduleSpecifier === "outer::Thing");

      expect(imports).toHaveLength(1);
      expect(imports[0].fromInlineBlock).toBeUndefined();
    });

    it("leaves a parenthesised macro invocation alone", () => {
      // Only `{}` is unwrapped: a `()` or `[]` invocation carries an
      // expression, not items. `automod::dir!("tests/builder")` names modules
      // that are nowhere written, and no reading of the source can find them.
      const specs = specsOf(`
mod real;
automod::dir!("tests/builder");
let v = vec![1, 2, 3];
`);

      expect(specs).toEqual(["real"]);
    });

    it("does not report a declaration twice when it sits outside every macro", () => {
      // The unwrapped source is re-read whole, so everything the first pass
      // found comes back with it. Subtracting as a multiset is what keeps the
      // existing edges, repeats included, exactly as they were.
      const specs = specsOf(`
mod outside;
cfg_io_util! {
    mod inside;
}
`);

      expect(specs.filter((s) => s === "outside")).toHaveLength(1);
      expect(specs.filter((s) => s === "inside")).toHaveLength(1);
    });

    it("reads a cfg_attr that names no path as naming none", () => {
      // Only `path` is picked out of what a `cfg_attr` would apply; a
      // `cfg_attr` carrying anything else leaves the module on convention.
      const specs = specsOf(`
#[cfg_attr(docsrs, doc(cfg(feature = "full")))]
mod plain;
`);

      expect(specs).toEqual(["plain"]);
    });

    it("marks a path attribute written inside an inline module", () => {
      const specs = specsOf(`
mod block {
    #[path = "moved.rs"]
    mod inner;
}
`);

      // rustc counts this one from the file's own module directory, one
      // directory deeper per inline level — unlike a declared module, which
      // counts from the directory the file sits in.
      expect(specs).toEqual(["self/block/moved.rs"]);
    });

    it("extracts an extern crate declaration", () => {
      const specs = specsOf(`
extern crate serde;
#[macro_use]
extern crate log;
extern crate my_lib as shorthand;
`);

      expect(specs).toEqual(["serde", "log", "my_lib"]);
    });

    it("places a mod declared inside an inline module under that module", () => {
      const specs = specsOf(`
mod outer {
    mod inner;
    mod deeper {
        mod leaf;
    }
}
mod beside;
`);

      expect(specs).toEqual(["self::outer::inner", "self::outer::deeper::leaf", "beside"]);
    });

    it("counts an inline module as a level a super:: path climbs", () => {
      const specs = specsOf(`
use super::sibling::Thing;

#[cfg(test)]
mod tests {
    use super::helper;
    use super::super::sibling::Other;
}
`);

      // At file level `super` reaches the parent module; the same word inside
      // `mod tests` reaches the file itself, so it takes one more to leave it.
      expect(specs).toEqual(["super::sibling::Thing", "self::helper", "super::sibling::Other"]);
    });

    it("records nothing for a glob import of the module a test block sits in", () => {
      const specs = specsOf(`
#[cfg(test)]
mod tests {
    use super::*;
}
`);

      // `use super::*;` inside `mod tests` names the file it is written in.
      expect(specs).toEqual([]);
    });

    // Whether a bare head written inside an inline block may reach the file's
    // own declarations. It travels as `fromInlineBlock`, not in the specifier,
    // which is identical under both readings — an assertion on the string would
    // pass either way and prove nothing.
    const blockedOf = (source: string, spec: string): boolean | undefined =>
      extractImports(source, "rust", ".rs").find((i) => i.moduleSpecifier === spec)?.fromInlineBlock;

    it("does not take a glob from another crate as the anchor", () => {
      // `use ::other::{*};` reaches outside this crate, so it brings in nothing
      // the file declares and cannot anchor a bare head. The leading `::` says
      // so, and stripping the prefix before the check is what let a group of
      // that shape read as an anchor — the same capture the marker exists to
      // prevent, in its braced spelling.
      const source = `
mod helper;

mod tests {
    use ::other::{*};
    use helper::build;
}
`;

      expect(specsOf(source)).toContain("::other");
      expect(blockedOf(source, "helper::build")).toBe(true);
    });

    it("counts the supers of a glob against the depth it is written at", () => {
      // One `super` leaves an inline block and lands on the file; written two
      // blocks deep the same word lands halfway, and brings in nothing the file
      // declares. Only a glob carrying exactly as many `super`s as there are
      // levels reaches the file's own scope — dropping that count let a shallow
      // glob anchor a head it cannot see.
      const source = `
mod helper;

mod outer {
    mod inner {
        use super::*;
        use helper::build;
    }
}
`;

      expect(blockedOf(source, "helper::build")).toBe(true);
    });

    it("follows a bare head into the inline block that declares it", () => {
      const specs = specsOf(`
#[cfg(test)]
mod tests {
    mod fixtures;
    use fixtures::build_store;
}
`);

      // `fixtures` is declared right there, so the path goes into the block —
      // `src/<file>/tests/fixtures.rs` — and not to a file of that name
      // sitting beside the declaring one.
      expect(specs).toEqual(["self::tests::fixtures::build_store", "self::tests::fixtures"]);
    });

    it("takes the directory of an inline module from its own path attribute", () => {
      const specs = specsOf(`
#[path = "other_dir"]
mod outer {
    pub mod child;
}
`);

      expect(specs).toEqual(["self::other_dir::child"]);
    });

    it("leaves a crate-anchored path alone inside an inline module", () => {
      const specs = specsOf(`
mod tests {
    use crate::db::Connection;
    use serde::Deserialize;
}
`);

      // `crate::` counts from the crate root, which no inline module moves;
      // and a bare head may name another crate, which rebasing would lose.
      expect(specs).toEqual(["crate::db::Connection", "serde::Deserialize"]);
    });

    it("expands a group whose first leaf is itself a group", () => {
      const specs = specsOf("use crate::{{parser, printer}, config};");

      // The depth counter has to see the opening brace of the very first
      // character of the group body. Starting the scan one character in
      // leaves depth at zero inside the nested group, and the comma that
      // separates its own leaves is then read as separating the outer ones.
      expect(specs).toEqual(["crate::parser", "crate::printer", "crate::config"]);
    });

    it("keeps a single-segment path written inside an inline module", () => {
      const specs = specsOf(`
mod tests {
    use standalone;
}
`);

      // One segment is still a path. The block declares nothing by that name,
      // so it is left alone the way any other bare head is — dropping it
      // loses the edge entirely.
      expect(specs).toEqual(["standalone"]);
    });

    it("keeps a leading :: inside an inline module that declares the same name", () => {
      const specs = specsOf(`
mod tests {
    mod config;
    use ::config::Item;
}
`);

      // The `::` says the head names a crate, and it says so precisely where
      // a module of that name is in scope — which is the one case where
      // rebasing the path into the block would reach the wrong file.
      expect(specs).toEqual(["::config::Item", "self::tests::config"]);
    });

    it("counts a self:: path from the inline module it is written in", () => {
      const specs = specsOf(`
mod tests {
    use self::helper::run;
}
`);

      // Inside `mod tests`, `self` is the block, so read from the file the
      // path names `tests::helper` — one level below where it would land if
      // the block were not there.
      expect(specs).toEqual(["self::tests::helper::run"]);
    });

    it("joins every inline level a rebased bare head passes through", () => {
      const specs = specsOf(`
mod outer {
    mod inner {
        mod fixtures;
        use fixtures::build;
    }
}
`);

      // Two levels, so the separator between them is written rather than
      // implied — a single level hides a missing `::` because there is
      // nothing to join.
      expect(specs).toEqual([
        "self::outer::inner::fixtures::build",
        "self::outer::inner::fixtures",
      ]);
    });

    it("marks a module declaration as a static import, whichever form it takes", () => {
      const imports = extractImports(
        `
#[path = "elsewhere/moved.rs"]
mod moved;
mod conventional;
`,
        "rust",
        ".rs",
      );

      // The flag decides the edge's type in the graph. A `mod` declaration is
      // as static as an import gets: nothing about it is decided at run time.
      expect(imports.map((i) => i.isDynamic)).toEqual([false, false]);
    });

    it("marks an extern crate declaration as a static import", () => {
      const imports = extractImports("extern crate serde;", "rust", ".rs");

      expect(imports.map((i) => i.isDynamic)).toEqual([false]);
    });

    it("records nothing for a crate that renames itself", () => {
      const specs = specsOf(`
extern crate self as this_crate;
extern crate serde;
`);

      // `extern crate self` names the crate the file is already in, which is
      // no edge — and resolving the word `self` as a module path would reach
      // the file's own directory.
      expect(specs).toEqual(["serde"]);
    });
  });

  // ── Go ─────────────────────────────────────────────────────────────────

  describe("Go imports", () => {
    it("extracts import declarations", () => {
      const source = `
package main

import (
    "fmt"
    "os"
    "github.com/user/repo/internal/utils"
)
`;
      const imports = extractImports(source, "go", ".go");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs.length).toBeGreaterThan(0);
      expect(specs.some((s) => s.includes("fmt"))).toBe(true);
    });
  });

  // ── Dart (regex-based) ─────────────────────────────────────────────────

  describe("Dart imports (regex)", () => {
    it("extracts import statements", () => {
      const source = `
import 'package:flutter/material.dart';
import 'dart:async';
import '../utils/helpers.dart';
export 'models.dart';
`;
      const imports = extractImports(source, "dart", ".dart");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs).toContain("package:flutter/material.dart");
      expect(specs).toContain("dart:async");
      expect(specs).toContain("../utils/helpers.dart");
      expect(specs).toContain("models.dart");
    });

    it("extracts part statements", () => {
      const source = `
part 'src/model.dart';
part 'src/widget.dart';
`;
      const imports = extractImports(source, "dart", ".dart");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs).toContain("src/model.dart");
      expect(specs).toContain("src/widget.dart");
    });
  });

  // ── Lua (regex-based) ──────────────────────────────────────────────────

  describe("Lua imports (regex)", () => {
    it("extracts require calls", () => {
      const source = `
local http = require("socket.http")
local json = require 'cjson'
`;
      const imports = extractImports(source, "lua", ".lua");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs).toContain("socket.http");
      expect(specs).toContain("cjson");
    });

    it("extracts dofile/loadfile calls", () => {
      const source = `
dofile("config.lua")
loadfile("data.lua")
`;
      const imports = extractImports(source, "lua", ".lua");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs).toContain("config.lua");
      expect(specs).toContain("data.lua");
    });
  });

  // ── PHP ────────────────────────────────────────────────────────────────

  describe("PHP imports", () => {
    it("extracts use statements", () => {
      const source = `<?php
namespace App\\Controllers;

use App\\Models\\User;
use Illuminate\\Http\\Request;
require_once './config.php';
include './helpers.php';
`;
      const imports = extractImports(source, "php", ".php");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs).toContain("App\\Models\\User");
      expect(specs).toContain("Illuminate\\Http\\Request");
      expect(specs).toContain("./config.php");
      expect(specs).toContain("./helpers.php");
    });

    it("extracts use with alias", () => {
      const source = `<?php
use App\\Models\\User as UserModel;
use App\\Services\\PaymentService as Payment;
`;
      const imports = extractImports(source, "php", ".php");
      const specs = imports.map((i) => i.moduleSpecifier);

      // Should extract the namespace, not the alias
      expect(specs).toContain("App\\Models\\User");
      expect(specs).toContain("App\\Services\\PaymentService");
      expect(specs).not.toContain("App\\Models\\User as UserModel");
    });

    it("extracts grouped use statements", () => {
      const source = `<?php
use App\\Models\\{User, Post, Comment};
`;
      const imports = extractImports(source, "php", ".php");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs).toContain("App\\Models\\User");
      expect(specs).toContain("App\\Models\\Post");
      expect(specs).toContain("App\\Models\\Comment");
    });

    it("extracts use function and use const", () => {
      const source = `<?php
use function App\\Helpers\\formatDate;
use const App\\Config\\MAX_RETRIES;
`;
      const imports = extractImports(source, "php", ".php");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs).toContain("App\\Helpers\\formatDate");
      expect(specs).toContain("App\\Config\\MAX_RETRIES");
    });

    it("extracts every name in a comma-separated use list", () => {
      // Only the first name survived before: the single-use regex matched the
      // head of the statement and the rest of the list was dropped silently.
      const source = `<?php
use App\\Models\\User, App\\Models\\Post;
use function App\\Helpers\\first, App\\Helpers\\second;
use App\\Models\\Role as R, App\\Models\\Team as T;
`;
      const specs = extractImports(source, "php", ".php").map((i) => i.moduleSpecifier);

      expect(specs).toContain("App\\Models\\User");
      expect(specs).toContain("App\\Models\\Post");
      expect(specs).toContain("App\\Helpers\\first");
      expect(specs).toContain("App\\Helpers\\second");
      expect(specs).toContain("App\\Models\\Role");
      expect(specs).toContain("App\\Models\\Team");
    });

    it("does not split a group's members into separate clauses", () => {
      // A group's internal commas separate members of one clause; the
      // statement-level commas above separate clauses. Splitting a group on
      // them yields `App\Models\{Alpha` and `Beta}`, neither of which names
      // anything. (PHP rejects a group and a further clause in one statement,
      // so the two forms only ever meet across statements, as here.)
      const source = `<?php
use App\\Models\\{Alpha, Beta};
use App\\Services\\Payments, App\\Services\\Refunds;
`;
      const specs = extractImports(source, "php", ".php").map((i) => i.moduleSpecifier);

      expect(specs).toEqual([
        "App\\Models\\Alpha",
        "App\\Models\\Beta",
        "App\\Services\\Payments",
        "App\\Services\\Refunds",
      ]);
    });

    it("strips function and const modifiers carried by group members", () => {
      // A group can carry the modifier per member rather than on the statement,
      // mixing a function, a constant and a class in one declaration. Left on,
      // the modifier became part of the name and the real one was lost.
      const source = `<?php
use App\\Helpers\\{function first, const MAX, User};
`;
      const specs = extractImports(source, "php", ".php").map((i) => i.moduleSpecifier);

      expect(specs).toEqual([
        "App\\Helpers\\first",
        "App\\Helpers\\MAX",
        "App\\Helpers\\User",
      ]);
    });

    it("handles a group split across lines", () => {
      const source = `<?php
use App\\Models\\{
    User,
    Post,
};
`;
      const specs = extractImports(source, "php", ".php").map((i) => i.moduleSpecifier);

      expect(specs).toEqual(["App\\Models\\User", "App\\Models\\Post"]);
    });

    it("keeps the leading backslash of a fully-qualified use", () => {
      // Extraction reports what the source says; the resolver strips it.
      const source = `<?php
use \\App\\Models\\User;
`;
      const specs = extractImports(source, "php", ".php").map((i) => i.moduleSpecifier);

      expect(specs).toContain("\\App\\Models\\User");
    });

    it("extracts __DIR__ and dirname(__FILE__) joined requires as source-relative paths", () => {
      // The dominant include idiom outside Composer projects. The old regex
      // demanded a quote right after require/(, so the __DIR__ prefix killed
      // the match and these statements yielded nothing at all.
      const source = `<?php
require_once __DIR__ . '/inc/util.php';
include __DIR__ . "/../lib/legacy.php";
require_once(__DIR__ . '/bootstrap.php');
require_once dirname(__FILE__) . '/old-school.php';
`;
      const specs = extractImports(source, "php", ".php").map((i) => i.moduleSpecifier);

      expect(specs).toContain("./inc/util.php");
      expect(specs).toContain("./../lib/legacy.php");
      expect(specs).toContain("./bootstrap.php");
      expect(specs).toContain("./old-school.php");
    });

    it("extracts a bare require path unchanged", () => {
      const source = `<?php
require 'inc/util.php';
`;
      const specs = extractImports(source, "php", ".php").map((i) => i.moduleSpecifier);

      expect(specs).toContain("inc/util.php");
    });

    it("extracts a require in return position", () => {
      // `return require __DIR__ . '/x.php';` is a return_statement, not an
      // expression_statement, and it is the standard shape of a config or
      // route file. Scanning only expression statements dropped all of them.
      const source = `<?php
return require __DIR__ . '/config.php';
`;
      const specs = extractImports(source, "php", ".php").map((i) => i.moduleSpecifier);

      expect(specs).toEqual(["./config.php"]);
    });

    it("extracts an include from any expression position", () => {
      // Matching the include expressions themselves rather than a list of
      // statement kinds means assignment, return, conditional and
      // error-suppressed forms all come along without being enumerated.
      const source = `<?php
$c = include 'assigned.php';
@include('suppressed.php');
if (true) { include_once 'conditional.php'; }
`;
      const specs = extractImports(source, "php", ".php").map((i) => i.moduleSpecifier);

      // Document order, not grouped by construct kind.
      expect(specs).toEqual(["assigned.php", "suppressed.php", "conditional.php"]);
    });

    it("does not mistake a method named after the construct for an include", () => {
      // `require` is a language construct, but nothing stops a method being
      // named after one, and `$loader->require('x.php')` includes no file.
      const source = `<?php
class Loader {
    public function boot($loader) {
        $loader->require('not-an-include.php');
        $loader->include_once("also-not.php");
        return Registry::require('nope.php');
    }
}
`;
      const specs = extractImports(source, "php", ".php").map((i) => i.moduleSpecifier);

      expect(specs).toEqual([]);
    });

    it("does not read an include out of a comment or a string", () => {
      // Both were real: this project's own tests carry Blade directives in
      // string literals, and its comments say things like "does NOT include
      // 'event'" — the old statement-text scan turned both into specifiers.
      const source = `<?php
// The ENUM does NOT include 'event' before the migration runs.
function template(): string {
    return "@include('partials/related-element-hosts')";
}
$msg = "remember to include 'legislative_session' here";
`;
      const specs = extractImports(source, "php", ".php").map((i) => i.moduleSpecifier);

      expect(specs).toEqual([]);
    });

    it("ignores a require joined to a constant or variable it cannot know", () => {
      // ABSPATH and $base are run-time values. Taking the literal tail alone
      // would invent a path the code may never include.
      const source = `<?php
require_once ABSPATH . '/wp-admin/includes/file.php';
require_once $base . '/config.php';
`;
      const specs = extractImports(source, "php", ".php").map((i) => i.moduleSpecifier);

      expect(specs).toEqual([]);
    });
  });

  // ── Ruby ───────────────────────────────────────────────────────────────

  describe("Ruby imports", () => {
    it("extracts require statements", () => {
      const source = `
require 'json'
require_relative './models/user'
require_relative '../lib/helpers'
`;
      const imports = extractImports(source, "ruby", ".rb");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs.length).toBeGreaterThan(0);
    });
  });

  // ── C/C++ ──────────────────────────────────────────────────────────────

  describe("C/C++ imports", () => {
    it("extracts include directives", () => {
      const source = `
#include <stdio.h>
#include "local_header.h"
#include "../utils/math.h"
`;
      const imports = extractImports(source, "c", ".c");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs.length).toBeGreaterThan(0);
    });
  });

  // ── Shell/Bash ─────────────────────────────────────────────────────────

  describe("Shell imports", () => {
    it("extracts source commands", () => {
      const source = `
#!/bin/bash
source ./config.sh
. ./utils.sh
`;
      const imports = extractImports(source, "bash", ".sh");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs.length).toBeGreaterThan(0);
    });
  });

  // ── Kotlin ──────────────────────────────────────────────────────────────

  describe("Kotlin imports", () => {
    it("extracts import headers", () => {
      const source = `
package com.example.app

import com.example.models.User
import com.example.utils.StringHelper
import kotlinx.coroutines.launch
`;
      const imports = extractImports(source, "kotlin", ".kt");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs.length).toBeGreaterThanOrEqual(3);
      expect(specs.some((s) => s.includes("com.example.models.User"))).toBe(
        true,
      );
      expect(
        specs.some((s) => s.includes("com.example.utils.StringHelper")),
      ).toBe(true);
    });

    it("handles wildcard imports", () => {
      const source = `
import com.example.models.*
`;
      const imports = extractImports(source, "kotlin", ".kt");

      expect(imports.length).toBeGreaterThanOrEqual(1);
      expect(
        imports.some((i) => i.moduleSpecifier.includes("com.example.models")),
      ).toBe(true);
    });
  });

  // ── Scala ───────────────────────────────────────────────────────────────

  describe("Scala imports", () => {
    it("extracts import declarations", () => {
      const source = `
package com.example

import scala.collection.mutable.ListBuffer
import com.example.models.User
import com.example.services._
`;
      const imports = extractImports(source, "scala", ".scala");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs.length).toBeGreaterThanOrEqual(2);
      expect(
        specs.some(
          (s) => s.includes("scala.collection") || s.includes("ListBuffer"),
        ),
      ).toBe(true);
    });
  });

  // ── Swift ───────────────────────────────────────────────────────────────

  describe("Swift imports", () => {
    it("extracts import declarations", () => {
      const source = `
import Foundation
import UIKit
import SwiftUI
`;
      const imports = extractImports(source, "swift", ".swift");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs.length).toBeGreaterThanOrEqual(3);
      expect(specs).toContain("Foundation");
      expect(specs).toContain("UIKit");
      expect(specs).toContain("SwiftUI");
    });

    it("handles no imports", () => {
      const source = `
func hello() -> String {
    return "world"
}
`;
      const imports = extractImports(source, "swift", ".swift");
      expect(imports).toHaveLength(0);
    });
  });

  // ── C# ─────────────────────────────────────────────────────────────────

  describe("C# imports", () => {
    it("extracts using directives", () => {
      const source = `
using System;
using System.Collections.Generic;
using MyApp.Models;
`;
      const imports = extractImports(source, "csharp", ".cs");
      const specs = imports.map((i) => i.moduleSpecifier);

      expect(specs.length).toBeGreaterThanOrEqual(3);
      expect(specs.some((s) => s.includes("System"))).toBe(true);
      expect(specs.some((s) => s.includes("MyApp.Models"))).toBe(true);
    });

    it("extracts static using directives", () => {
      const source = `
using static System.Math;
`;
      const imports = extractImports(source, "csharp", ".cs");

      expect(imports.length).toBeGreaterThanOrEqual(1);
      expect(
        imports.some((i) => i.moduleSpecifier.includes("System.Math")),
      ).toBe(true);
    });

    it("skips using alias directives", () => {
      const source = `
using Alias = System.Collections.Generic.List<int>;
`;
      const imports = extractImports(source, "csharp", ".cs");
      // Using aliases (using X = ...) should be filtered out
      expect(imports).toHaveLength(0);
    });
  });
});
