// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited

/** A small lexical token used by GDScript fallbacks that run without the native parser. */
export interface GdscriptToken {
  kind: "identifier" | "string" | "punctuation";
  text: string;
}

const IDENTIFIER_START = /^[_\p{ID_Start}]$/u;
const IDENTIFIER_CONTINUE = /^[_\p{ID_Continue}]$/u;

/** Return one Unicode code point without splitting surrogate pairs. */
function codePointAt(source: string, index: number): string {
  const codePoint = source.codePointAt(index);
  return codePoint === undefined ? "" : String.fromCodePoint(codePoint);
}

/**
 * Tokenize only the GDScript constructs needed by import and class-name fallbacks.
 * Comments and whitespace are discarded, while quoted strings remain single tokens.
 */
export function tokenizeGdscript(source: string): GdscriptToken[] {
  const tokens: GdscriptToken[] = [];
  let index = 0;

  while (index < source.length) {
    const current = codePointAt(source, index);
    if (/^\s$/u.test(current)) {
      index += current.length;
      continue;
    }

    if (current === "#") {
      while (index < source.length && source[index] !== "\n" && source[index] !== "\r") {
        index++;
      }
      continue;
    }

    const rawPrefix = (current === "r" || current === "R")
      && (source[index + 1] === "\"" || source[index + 1] === "'");
    const quoteIndex = rawPrefix ? index + 1 : index;
    const quote = source[quoteIndex];
    if (quote === "\"" || quote === "'") {
      const start = index;
      const triple = source.slice(quoteIndex, quoteIndex + 3) === quote.repeat(3);
      const delimiterLength = triple ? 3 : 1;
      index = quoteIndex + delimiterLength;

      while (index < source.length) {
        // Raw strings still recognize an escaped matching quote (and `\\\\`).
        // Skip the escaped code point before checking for the closing delimiter
        // so `r"quoted: \\" text"` remains one string token.
        if (source[index] === "\\") {
          index += Math.min(2, source.length - index);
          continue;
        }
        if (source.slice(index, index + delimiterLength) === quote.repeat(delimiterLength)) {
          index += delimiterLength;
          break;
        }
        if (!triple && (source[index] === "\n" || source[index] === "\r")) break;
        index++;
      }

      tokens.push({ kind: "string", text: source.slice(start, index) });
      continue;
    }

    if (IDENTIFIER_START.test(current)) {
      const start = index;
      index += current.length;
      while (index < source.length) {
        const next = codePointAt(source, index);
        if (!IDENTIFIER_CONTINUE.test(next)) break;
        index += next.length;
      }
      tokens.push({ kind: "identifier", text: source.slice(start, index) });
      continue;
    }

    tokens.push({ kind: "punctuation", text: current });
    index += current.length;
  }

  return tokens;
}

/** Find a real class_name declaration while ignoring comments and string bodies. */
export function extractClassNameFromGdscript(source: string): string | null {
  const tokens = tokenizeGdscript(source);
  for (let index = 0; index < tokens.length - 1; index++) {
    const token = tokens[index];
    if (token.kind !== "identifier" || token.text !== "class_name") continue;
    if (tokens[index - 1]?.text === ".") continue;
    const name = tokens[index + 1];
    if (name?.kind === "identifier") return name.text;
  }
  return null;
}
