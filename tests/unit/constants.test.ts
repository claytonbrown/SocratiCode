// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHUNK_OVERLAP,
  CHUNK_SIZE,
  detectExtensionlessExtension,
  getLanguageFromExtension,
  getWatcherMode,
  INDEX_BATCH_SIZE,
  indexExtensionlessEnabled,
  MAX_AVG_LINE_LENGTH,
  MAX_CHUNK_CHARS,
  MAX_FILE_BYTES,
  mergeExtraExtensions,
  OLLAMA_CONTAINER_NAME,
  OLLAMA_HOST,
  OLLAMA_IMAGE,
  OLLAMA_PORT,
  parseExtensionLanguageMap,
  parseExtraExtensions,
  QDRANT_CONTAINER_NAME,
  QDRANT_GRPC_PORT,
  QDRANT_HOST,
  QDRANT_IMAGE,
  QDRANT_MODE,
  QDRANT_PORT,
  QDRANT_URL,
  resolveQdrantPort,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MIN_SCORE,
  SPECIAL_FILES,
  SUPPORTED_EXTENSIONS,
  toForwardSlash,
} from "../../src/constants.js";

describe("constants", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("watcher mode", () => {
    it("defaults to auto when SOCRATICODE_WATCHER is unset or empty", () => {
      vi.stubEnv("SOCRATICODE_WATCHER", undefined);
      expect(getWatcherMode()).toBe("auto");
      vi.stubEnv("SOCRATICODE_WATCHER", "   ");
      expect(getWatcherMode()).toBe("auto");
    });

    it("accepts auto, manual, and off case-insensitively", () => {
      vi.stubEnv("SOCRATICODE_WATCHER", " AUTO ");
      expect(getWatcherMode()).toBe("auto");
      vi.stubEnv("SOCRATICODE_WATCHER", " Manual ");
      expect(getWatcherMode()).toBe("manual");
      vi.stubEnv("SOCRATICODE_WATCHER", " OFF ");
      expect(getWatcherMode()).toBe("off");
    });

    it("rejects unknown values instead of silently enabling automatic writes", () => {
      vi.stubEnv("SOCRATICODE_WATCHER", "disabled");
      expect(() => getWatcherMode()).toThrow(
        'Invalid SOCRATICODE_WATCHER: "disabled". Must be "auto", "manual", or "off".',
      );
    });
  });

  describe("Qdrant configuration", () => {
    it("has default port 16333", () => {
      expect(QDRANT_PORT).toBe(16333);
    });

    it("has default gRPC port 16334", () => {
      expect(QDRANT_GRPC_PORT).toBe(16334);
    });

    it("defaults host to localhost", () => {
      expect(QDRANT_HOST).toBe("localhost");
    });

    it("has correct container name", () => {
      expect(QDRANT_CONTAINER_NAME).toBe("socraticode-qdrant");
    });

    it("uses pinned Qdrant image version", () => {
      expect(QDRANT_IMAGE).toMatch(/^qdrant\/qdrant:v\d+\.\d+\.\d+$/);
    });

    it("defaults mode to managed", () => {
      expect(QDRANT_MODE).toBe("managed");
    });

    it("defaults URL to undefined", () => {
      expect(QDRANT_URL).toBeUndefined();
    });
  });

  describe("Ollama configuration", () => {
    it("has default port 11435", () => {
      expect(OLLAMA_PORT).toBe(11435);
    });

    it("defaults host to localhost with configured port", () => {
      expect(OLLAMA_HOST).toBe(`http://localhost:${OLLAMA_PORT}`);
    });

    it("has correct container name", () => {
      expect(OLLAMA_CONTAINER_NAME).toBe("socraticode-ollama");
    });

    it("uses latest Ollama image", () => {
      expect(OLLAMA_IMAGE).toBe("ollama/ollama:latest");
    });
  });

  describe("chunking configuration", () => {
    it("has reasonable chunk size", () => {
      expect(CHUNK_SIZE).toBeGreaterThan(0);
      expect(CHUNK_SIZE).toBeLessThanOrEqual(500);
    });

    it("has overlap smaller than chunk size", () => {
      expect(CHUNK_OVERLAP).toBeGreaterThan(0);
      expect(CHUNK_OVERLAP).toBeLessThan(CHUNK_SIZE);
    });

    it("defaults to 100 lines per chunk", () => {
      expect(CHUNK_SIZE).toBe(100);
    });

    it("defaults to 10 lines overlap", () => {
      expect(CHUNK_OVERLAP).toBe(10);
    });
  });

  describe("search configuration", () => {
    it("defaults SEARCH_DEFAULT_LIMIT to 10", () => {
      expect(SEARCH_DEFAULT_LIMIT).toBe(10);
    });

    it("clamps SEARCH_DEFAULT_LIMIT between 1 and 50", () => {
      // Can't easily test env override in-process, but verify the default is within bounds
      expect(SEARCH_DEFAULT_LIMIT).toBeGreaterThanOrEqual(1);
      expect(SEARCH_DEFAULT_LIMIT).toBeLessThanOrEqual(50);
    });

    it("defaults SEARCH_MIN_SCORE to 0.10", () => {
      expect(SEARCH_MIN_SCORE).toBeCloseTo(0.10);
    });

    it("clamps SEARCH_MIN_SCORE between 0 and 1", () => {
      expect(SEARCH_MIN_SCORE).toBeGreaterThanOrEqual(0);
      expect(SEARCH_MIN_SCORE).toBeLessThanOrEqual(1);
    });
  });

  describe("indexing configuration", () => {
    it("defaults INDEX_BATCH_SIZE to 50", () => {
      expect(INDEX_BATCH_SIZE).toBe(50);
    });

    it("defaults MAX_FILE_BYTES to 5MB", () => {
      expect(MAX_FILE_BYTES).toBe(5_000_000);
    });

    it("MAX_AVG_LINE_LENGTH is a positive number", () => {
      expect(MAX_AVG_LINE_LENGTH).toBeGreaterThan(0);
    });

    it("defaults MAX_AVG_LINE_LENGTH to 500", () => {
      expect(MAX_AVG_LINE_LENGTH).toBe(500);
    });

    it("MAX_CHUNK_CHARS is a positive number", () => {
      expect(MAX_CHUNK_CHARS).toBeGreaterThan(0);
    });

    it("defaults MAX_CHUNK_CHARS to 2000", () => {
      expect(MAX_CHUNK_CHARS).toBe(2000);
    });

    it("MAX_CHUNK_CHARS is less than MAX_AVG_LINE_LENGTH * CHUNK_SIZE (sanity check)", () => {
      // Ensures MAX_CHUNK_CHARS is a tighter limit than unconstrained line-based chunks
      expect(MAX_CHUNK_CHARS).toBeLessThan(MAX_AVG_LINE_LENGTH * CHUNK_SIZE);
    });
  });

  describe("SUPPORTED_EXTENSIONS", () => {
    it("is a Set", () => {
      expect(SUPPORTED_EXTENSIONS).toBeInstanceOf(Set);
    });

    it("contains common programming language extensions", () => {
      const expected = [".js", ".ts", ".py", ".java", ".go", ".rs", ".rb", ".php", ".swift", ".c", ".cpp"];
      for (const ext of expected) {
        expect(SUPPORTED_EXTENSIONS.has(ext), `missing: ${ext}`).toBe(true);
      }
    });

    it("contains TypeScript variants", () => {
      expect(SUPPORTED_EXTENSIONS.has(".ts")).toBe(true);
      expect(SUPPORTED_EXTENSIONS.has(".tsx")).toBe(true);
      expect(SUPPORTED_EXTENSIONS.has(".mjs")).toBe(true);
      expect(SUPPORTED_EXTENSIONS.has(".cjs")).toBe(true);
    });

    it("contains web extensions", () => {
      expect(SUPPORTED_EXTENSIONS.has(".html")).toBe(true);
      expect(SUPPORTED_EXTENSIONS.has(".css")).toBe(true);
      expect(SUPPORTED_EXTENSIONS.has(".scss")).toBe(true);
      expect(SUPPORTED_EXTENSIONS.has(".styl")).toBe(true);
      expect(SUPPORTED_EXTENSIONS.has(".vue")).toBe(true);
      expect(SUPPORTED_EXTENSIONS.has(".svelte")).toBe(true);
    });

    it("contains config/data extensions", () => {
      expect(SUPPORTED_EXTENSIONS.has(".json")).toBe(true);
      expect(SUPPORTED_EXTENSIONS.has(".yaml")).toBe(true);
      expect(SUPPORTED_EXTENSIONS.has(".yml")).toBe(true);
      expect(SUPPORTED_EXTENSIONS.has(".toml")).toBe(true);
      expect(SUPPORTED_EXTENSIONS.has(".xml")).toBe(true);
    });

    it("contains documentation extensions", () => {
      expect(SUPPORTED_EXTENSIONS.has(".md")).toBe(true);
      expect(SUPPORTED_EXTENSIONS.has(".mdx")).toBe(true);
      expect(SUPPORTED_EXTENSIONS.has(".rst")).toBe(true);
      expect(SUPPORTED_EXTENSIONS.has(".txt")).toBe(true);
    });

    it("does not contain binary or image extensions", () => {
      expect(SUPPORTED_EXTENSIONS.has(".png")).toBe(false);
      expect(SUPPORTED_EXTENSIONS.has(".jpg")).toBe(false);
      expect(SUPPORTED_EXTENSIONS.has(".exe")).toBe(false);
      expect(SUPPORTED_EXTENSIONS.has(".pdf")).toBe(false);
    });

    it("has at least 50 extensions", () => {
      expect(SUPPORTED_EXTENSIONS.size).toBeGreaterThanOrEqual(50);
    });
  });

  describe("SPECIAL_FILES", () => {
    it("is a Set", () => {
      expect(SPECIAL_FILES).toBeInstanceOf(Set);
    });

    it("includes Dockerfile", () => {
      expect(SPECIAL_FILES.has("Dockerfile")).toBe(true);
    });

    it("includes Makefile", () => {
      expect(SPECIAL_FILES.has("Makefile")).toBe(true);
    });

    it("includes Gemfile", () => {
      expect(SPECIAL_FILES.has("Gemfile")).toBe(true);
    });

    it("includes .gitignore", () => {
      expect(SPECIAL_FILES.has(".gitignore")).toBe(true);
    });

    it("includes .env.example", () => {
      expect(SPECIAL_FILES.has(".env.example")).toBe(true);
    });
  });

  describe("getLanguageFromExtension", () => {
    it("maps .ts to typescript", () => {
      expect(getLanguageFromExtension(".ts")).toBe("typescript");
    });

    it("maps .tsx to typescript", () => {
      expect(getLanguageFromExtension(".tsx")).toBe("typescript");
    });

    it("maps .js to javascript", () => {
      expect(getLanguageFromExtension(".js")).toBe("javascript");
    });

    it("maps .py to python", () => {
      expect(getLanguageFromExtension(".py")).toBe("python");
    });

    it("maps .java to java", () => {
      expect(getLanguageFromExtension(".java")).toBe("java");
    });

    it("maps .go to go", () => {
      expect(getLanguageFromExtension(".go")).toBe("go");
    });

    it("maps .rs to rust", () => {
      expect(getLanguageFromExtension(".rs")).toBe("rust");
    });

    it("maps .rb to ruby", () => {
      expect(getLanguageFromExtension(".rb")).toBe("ruby");
    });

    it("maps .cpp to cpp", () => {
      expect(getLanguageFromExtension(".cpp")).toBe("cpp");
    });

    it("maps .cs to csharp", () => {
      expect(getLanguageFromExtension(".cs")).toBe("csharp");
    });

    it("maps .swift to swift", () => {
      expect(getLanguageFromExtension(".swift")).toBe("swift");
    });

    it("maps .sh to shell", () => {
      expect(getLanguageFromExtension(".sh")).toBe("shell");
    });

    it("maps .styl to stylus", () => {
      expect(getLanguageFromExtension(".styl")).toBe("stylus");
    });

    it("maps .md to markdown", () => {
      expect(getLanguageFromExtension(".md")).toBe("markdown");
    });

    it("maps .dart to dart", () => {
      expect(getLanguageFromExtension(".dart")).toBe("dart");
    });

    it("maps .lua to lua", () => {
      expect(getLanguageFromExtension(".lua")).toBe("lua");
    });

    it("maps .sql to sql", () => {
      expect(getLanguageFromExtension(".sql")).toBe("sql");
    });

    it("returns plaintext for unknown extensions", () => {
      expect(getLanguageFromExtension(".xyz")).toBe("plaintext");
      expect(getLanguageFromExtension(".abc")).toBe("plaintext");
      expect(getLanguageFromExtension("")).toBe("plaintext");
    });

    it("maps .r and .R to r", () => {
      expect(getLanguageFromExtension(".r")).toBe("r");
      expect(getLanguageFromExtension(".R")).toBe("r");
    });

    it("maps .kt to kotlin", () => {
      expect(getLanguageFromExtension(".kt")).toBe("kotlin");
    });

    it("maps .scala to scala", () => {
      expect(getLanguageFromExtension(".scala")).toBe("scala");
    });

    it("maps .php to php", () => {
      expect(getLanguageFromExtension(".php")).toBe("php");
    });

    it("resolves an EXTENSION_LANGUAGE_MAP override to the target language label", () => {
      const override = new Map([[".inc", ".php"]]);
      expect(getLanguageFromExtension(".inc", override)).toBe("php");
      // Case-insensitive: an uppercase ext still matches the lowercased key.
      expect(getLanguageFromExtension(".INC", override)).toBe("php");
      // Unmapped extensions are unaffected by the override.
      expect(getLanguageFromExtension(".xyz", override)).toBe("plaintext");
    });

    it("an empty override leaves built-in mappings unchanged", () => {
      const empty = new Map<string, string>();
      expect(getLanguageFromExtension(".inc", empty)).toBe("plaintext");
      expect(getLanguageFromExtension(".ts", empty)).toBe("typescript");
    });
  });

  describe("parseExtensionLanguageMap", () => {
    it("returns empty map and no invalid entries for undefined/empty", () => {
      expect(parseExtensionLanguageMap(undefined)).toEqual({ map: new Map(), invalid: [] });
      expect(parseExtensionLanguageMap("  ")).toEqual({ map: new Map(), invalid: [] });
    });

    it("maps an extension to its target language's canonical extension", () => {
      const { map, invalid } = parseExtensionLanguageMap(".inc:php");
      expect(map.get(".inc")).toBe(".php");
      expect(invalid).toEqual([]);
    });

    it("accepts stylus as a target language, like its CSS siblings", () => {
      const { map, invalid } = parseExtensionLanguageMap(".styles:stylus,.sheet:less");
      expect(map.get(".styles")).toBe(".styl");
      expect(map.get(".sheet")).toBe(".less");
      expect(invalid).toEqual([]);
      expect(getLanguageFromExtension(".styles", map)).toBe("stylus");
    });

    it("normalizes the extension (lowercases, adds leading dot)", () => {
      const { map } = parseExtensionLanguageMap("MODULE:php");
      expect(map.get(".module")).toBe(".php");
    });

    it("resolves the vocabulary difference via canonical extension", () => {
      // `shell` label vs `bash` grammar, and the Lang-enum languages, are all
      // reached through the canonical extension, not re-encoded here.
      const { map } = parseExtensionLanguageMap(".bashrc:shell,.component:typescript");
      expect(map.get(".bashrc")).toBe(".sh");
      expect(map.get(".component")).toBe(".ts");
    });

    it("accepts common language aliases", () => {
      const { map } = parseExtensionLanguageMap(".a:c++,.b:c#,.c:golang,.d:py");
      expect(map.get(".a")).toBe(".cpp");
      expect(map.get(".b")).toBe(".cs");
      expect(map.get(".c")).toBe(".go");
      expect(map.get(".d")).toBe(".py");
    });

    it("rejects a target language with no AST grammar (e.g. the reporter's .foo:bar)", () => {
      const { map, invalid } = parseExtensionLanguageMap(".foo:bar,.txt:markdown");
      expect(map.size).toBe(0);
      expect(invalid).toEqual([".foo:bar", ".txt:markdown"]);
    });

    it("rejects malformed entries (no colon, no extension, no language)", () => {
      const { map, invalid } = parseExtensionLanguageMap("badentry,:php,.x:");
      expect(map.size).toBe(0);
      expect(invalid).toEqual(["badentry", ":php", ".x:"]);
    });

    it("keeps valid entries while rejecting invalid ones in the same value", () => {
      const { map, invalid } = parseExtensionLanguageMap(".inc:php, .foo:bar, .h:cpp");
      expect([...map.entries()]).toEqual([[".inc", ".php"], [".h", ".cpp"]]);
      expect(invalid).toEqual([".foo:bar"]);
    });

    it("last value wins for a repeated extension", () => {
      const { map } = parseExtensionLanguageMap(".inc:php,.inc:python");
      expect(map.get(".inc")).toBe(".py");
    });
  });

  describe("parseExtraExtensions", () => {
    it("returns empty set for undefined", () => {
      expect(parseExtraExtensions(undefined).size).toBe(0);
    });

    it("returns empty set for empty string", () => {
      expect(parseExtraExtensions("").size).toBe(0);
    });

    it("returns empty set for whitespace-only", () => {
      expect(parseExtraExtensions("  ").size).toBe(0);
    });

    it("parses comma-separated extensions with dots", () => {
      const result = parseExtraExtensions(".tpl,.blade,.hbs");
      expect(result).toEqual(new Set([".tpl", ".blade", ".hbs"]));
    });

    it("adds leading dots when missing", () => {
      const result = parseExtraExtensions("tpl,blade");
      expect(result).toEqual(new Set([".tpl", ".blade"]));
    });

    it("trims whitespace and lowercases", () => {
      const result = parseExtraExtensions("  .TPL , .Blade  ");
      expect(result).toEqual(new Set([".tpl", ".blade"]));
    });

    it("deduplicates entries", () => {
      const result = parseExtraExtensions(".tpl,.tpl,tpl");
      expect(result.size).toBe(1);
      expect(result.has(".tpl")).toBe(true);
    });
  });

  describe("mergeExtraExtensions", () => {
    it("returns env var default when no tool param", () => {
      // EXTRA_EXTENSIONS env var is not set in test environment, so should be empty
      const result = mergeExtraExtensions();
      expect(result.size).toBe(0);
    });

    it("returns tool param extensions when provided", () => {
      const result = mergeExtraExtensions(".tpl,.blade");
      expect(result).toEqual(new Set([".tpl", ".blade"]));
    });

    it("returns empty for undefined tool param", () => {
      const result = mergeExtraExtensions(undefined);
      expect(result.size).toBe(0);
    });
  });
});

describe("toForwardSlash", () => {
  it("returns the same string when no backslashes are present", () => {
    expect(toForwardSlash("src/index.ts")).toBe("src/index.ts");
  });

  it("replaces single backslash with forward slash", () => {
    expect(toForwardSlash("src\\index.ts")).toBe("src/index.ts");
  });

  it("replaces multiple backslashes in a path", () => {
    expect(toForwardSlash("src\\services\\graph-analysis.ts")).toBe("src/services/graph-analysis.ts");
  });

  it("handles deeply nested Windows paths", () => {
    expect(toForwardSlash("src\\a\\b\\c\\d\\file.ts")).toBe("src/a/b/c/d/file.ts");
  });

  it("handles empty string", () => {
    expect(toForwardSlash("")).toBe("");
  });

  it("handles path with mixed separators", () => {
    expect(toForwardSlash("src/services\\graph-analysis.ts")).toBe("src/services/graph-analysis.ts");
  });

  it("is a no-op on POSIX-style paths", () => {
    const posixPath = "src/services/code-graph.ts";
    expect(toForwardSlash(posixPath)).toBe(posixPath);
  });
});

describe("resolveQdrantPort", () => {
  it("returns explicit port from URL", () => {
    expect(resolveQdrantPort("https://qdrant.example.com:6333")).toBe(6333);
    expect(resolveQdrantPort("http://localhost:8080")).toBe(8080);
    expect(resolveQdrantPort("https://my-qdrant.com:8443")).toBe(8443);
  });

  it("defaults to 443 for HTTPS URLs without explicit port", () => {
    expect(resolveQdrantPort("https://qdrant.example.com")).toBe(443);
    expect(resolveQdrantPort("https://my-tunnel.trycloudflare.com")).toBe(443);
  });

  it("defaults to 6333 for HTTP URLs without explicit port", () => {
    expect(resolveQdrantPort("http://localhost")).toBe(6333);
    expect(resolveQdrantPort("http://192.168.1.100")).toBe(6333);
  });

  it("handles URLs with paths and query strings", () => {
    expect(resolveQdrantPort("https://qdrant.example.com:9999/some/path")).toBe(9999);
    expect(resolveQdrantPort("https://qdrant.example.com/some/path")).toBe(443);
  });
});

describe("detectExtensionlessExtension", () => {
  // ── Stage 0: binary guard ──
  it("rejects content with a NUL byte (binary/UTF-16)", () => {
    expect(detectExtensionlessExtension("#!/bin/bash\n\u0000\u0000")).toBeNull();
    expect(detectExtensionlessExtension("h\u0000i\u0000")).toBeNull();
  });

  // ── Stage 1: shebang → mapped interpreter ──
  it("maps common shebang interpreters to canonical extensions", () => {
    expect(detectExtensionlessExtension("#!/bin/bash\necho hi\n")).toBe(".sh");
    expect(detectExtensionlessExtension("#!/bin/sh\n")).toBe(".sh");
    expect(detectExtensionlessExtension("#!/usr/bin/env python3\n")).toBe(".py");
    expect(detectExtensionlessExtension("#!/usr/bin/env node\n")).toBe(".js");
    expect(detectExtensionlessExtension("#!/usr/bin/ruby\n")).toBe(".rb");
  });

  it("chases wrapper interpreters (env / with-contenv)", () => {
    expect(detectExtensionlessExtension("#!/usr/bin/with-contenv sh\n")).toBe(".sh");
    expect(detectExtensionlessExtension("#!/usr/bin/env -S python3 -u\n")).toBe(".py");
    expect(detectExtensionlessExtension("#!/usr/bin/env -S PYTHONPATH=/x python3\n")).toBe(".py");
  });

  it("consumes wrapper flag-arguments during the chase", () => {
    expect(detectExtensionlessExtension("#!/usr/bin/sudo -u www-data python3\n")).toBe(".py");
    expect(detectExtensionlessExtension("#!/usr/bin/nice -n 19 /bin/bash\n")).toBe(".sh");
  });

  it("treats a wrapper's boolean flags as no-arg (does not swallow the interpreter)", () => {
    // `-n` consumes an argument for `nice` but is boolean for `sudo`; the chase
    // must be wrapper-aware or it eats the interpreter and degrades to .txt.
    expect(detectExtensionlessExtension("#!/usr/bin/sudo -n python3\n")).toBe(".py");
    expect(detectExtensionlessExtension("#!/usr/bin/sudo -n /bin/bash\n")).toBe(".sh");
  });

  it("consumes the env/doas -u arg-flag (pins those WRAPPER_ARG_FLAGS rows)", () => {
    // Removing env's or doas's `-u` entry would let the arg be read as the
    // interpreter and degrade to .txt.
    expect(detectExtensionlessExtension("#!/usr/bin/env -u LD_PRELOAD python3\n")).toBe(".py");
    expect(detectExtensionlessExtension("#!/usr/bin/doas -u nobody python3\n")).toBe(".py");
  });

  it("chases stacked wrappers (while-loop) and the time wrapper", () => {
    // env → nice → python3 needs two chase iterations; a while→if regression
    // would resolve only the outer wrapper and mis-detect.
    expect(detectExtensionlessExtension("#!/usr/bin/env nice -n 10 python3\n")).toBe(".py");
    expect(detectExtensionlessExtension("#!/usr/bin/time python3\n")).toBe(".py");
  });

  it("handles CRLF shebang lines", () => {
    expect(detectExtensionlessExtension("#!/bin/bash\r\necho hi\r\n")).toBe(".sh");
    expect(detectExtensionlessExtension("#!/usr/bin/env python3\r\n")).toBe(".py");
  });

  it("maps the full interpreter table", () => {
    expect(detectExtensionlessExtension("#!/usr/bin/php\n")).toBe(".php");
    expect(detectExtensionlessExtension("#!/usr/bin/lua\n")).toBe(".lua");
    expect(detectExtensionlessExtension("#!/bin/zsh\n")).toBe(".sh");
    expect(detectExtensionlessExtension("#!/bin/dash\n")).toBe(".sh");
    expect(detectExtensionlessExtension("#!/bin/ksh\n")).toBe(".sh");
    expect(detectExtensionlessExtension("#!/bin/ash\n")).toBe(".sh");
    expect(detectExtensionlessExtension("#!/usr/bin/env nodejs\n")).toBe(".js");
  });

  it("normalizes versioned interpreter names", () => {
    expect(detectExtensionlessExtension("#!/usr/bin/python3.6\n")).toBe(".py");
    expect(detectExtensionlessExtension("#!/usr/bin/python2\n")).toBe(".py");
    // ABI-flag suffixes (d=debug, m=pymalloc, u=wide-unicode builds) normalize too.
    expect(detectExtensionlessExtension("#!/usr/bin/python3.6m\n")).toBe(".py");
    expect(detectExtensionlessExtension("#!/usr/bin/python3.7dm\n")).toBe(".py");
    expect(detectExtensionlessExtension("#!/usr/bin/python2.7mu\n")).toBe(".py");
  });

  // ── Stage 1: shebang → unmapped interpreter → .txt ──
  it("maps a shebang with an unmapped interpreter to .txt", () => {
    expect(detectExtensionlessExtension("#!/usr/bin/perl\nprint 1;\n")).toBe(".txt");
    expect(detectExtensionlessExtension("#!/usr/bin/make -f\n")).toBe(".txt");
    expect(detectExtensionlessExtension("#!/usr/bin/env\n")).toBe(".txt");
  });

  // ── Stage 2: content sniff — positives ──
  it("sniffs no-shebang Python (waf wscript style)", () => {
    const wscript =
      "top = '.'\nout = 'build'\n\ndef configure(conf):\n    conf.load('compiler_c')\n\ndef build(bld):\n    bld.program(source='main.c', target='app')\n";
    expect(detectExtensionlessExtension(wscript)).toBe(".py");
  });

  it("sniffs no-shebang shell (>=2 distinct patterns)", () => {
    const profile = `set -eu\nif [ -d /etc/profile.d ]; then\n  echo x\nfi\nexport PATH="\${HOME}/bin:$PATH"\n`;
    expect(detectExtensionlessExtension(profile)).toBe(".sh");
  });

  it("applies sniff precedence when both languages score (py wins ties, else shell)", () => {
    // 1 python hit + 2 distinct shell hits: py-hits < sh-hits → shell.
    expect(detectExtensionlessExtension("import os\nset -eu\nfi\ndone\n")).toBe(".sh");
    // 1 python hit + 1 shell hit: py-hits >= sh-hits → python.
    expect(detectExtensionlessExtension("import os\nset -eu\n")).toBe(".py");
  });

  // Each of these isolates a single sniff pattern at the >=threshold boundary:
  // exactly enough hits to classify, so removing the target regex drops below
  // threshold and the file no longer detects. (Guards the rows the positive
  // tests above never make load-bearing.)
  it("shell sniff pins the if/then + function-keyword patterns at threshold", () => {
    expect(detectExtensionlessExtension("if [ -f x ]; then\nfunction handler\n")).toBe(".sh");
  });
  it("shell sniff pins the name() { + braced-var patterns at threshold", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell ${VAR} inside a single-quoted JS string, not a template placeholder
    expect(detectExtensionlessExtension('svc() {\n  echo "${HOME}"\n}\n')).toBe(".sh");
  });
  it("python sniff pins the from-import pattern", () => {
    expect(detectExtensionlessExtension("from os import path\n")).toBe(".py");
  });
  it("python sniff pins the colon-terminated class pattern", () => {
    expect(detectExtensionlessExtension("class Config:\n    x = 1\n")).toBe(".py");
  });

  // ── Stage 2: content sniff — negatives (null) ──
  it("returns null for a declarative Jenkinsfile (no imports, no colon-def)", () => {
    const jf = `pipeline {\n  agent any\n  stages {\n    stage('build') { steps { sh 'make' } }\n  }\n}\ndef helper = { -> 1 }\n`;
    expect(detectExtensionlessExtension(jf)).toBeNull();
  });

  it("returns null for prose / config and a single shell pattern", () => {
    expect(
      detectExtensionlessExtension("MIT License\n\nCopyright (c) 2026\nPermission is hereby granted...\n"),
    ).toBeNull();
    expect(detectExtensionlessExtension("name: build\non:\n  push:\n    branches: [main]\n")).toBeNull();
    expect(detectExtensionlessExtension("esac\n")).toBeNull(); // one shell pattern only, below threshold
    expect(detectExtensionlessExtension("")).toBeNull();
  });

  // Scripted Jenkinsfile with a bare import → knowingly detected as .py.
  it("detects import-bearing Groovy as .py (accepted mislabel)", () => {
    const scripted = "import jenkins.model.Jenkins\n\nnode {\n  stage('x') { echo 'hi' }\n}\n";
    expect(detectExtensionlessExtension(scripted)).toBe(".py");
  });
});

describe("indexExtensionlessEnabled", () => {
  it("defaults to true when unset", () => {
    vi.stubEnv("INDEX_EXTENSIONLESS", "");
    expect(indexExtensionlessEnabled()).toBe(true);
    vi.unstubAllEnvs();
  });
  it("is false for 'false' and '0' (case-insensitive)", () => {
    vi.stubEnv("INDEX_EXTENSIONLESS", "false");
    expect(indexExtensionlessEnabled()).toBe(false);
    vi.stubEnv("INDEX_EXTENSIONLESS", "0");
    expect(indexExtensionlessEnabled()).toBe(false);
    vi.stubEnv("INDEX_EXTENSIONLESS", "FALSE");
    expect(indexExtensionlessEnabled()).toBe(false);
    vi.unstubAllEnvs();
  });
  it("is true for other values", () => {
    vi.stubEnv("INDEX_EXTENSIONLESS", "true");
    expect(indexExtensionlessEnabled()).toBe(true);
    vi.unstubAllEnvs();
  });
});
