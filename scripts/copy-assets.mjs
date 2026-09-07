// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Giancarlo Erra - Altaire Limited
//
// Copy src/assets/ → dist/assets/ after tsc compile.
// tsc does not copy non-TS files; this keeps the vendored Cytoscape + Dagre
// bundles available to the interactive graph visualiser at runtime.
// Also copies the GDScript preflight .cjs script to dist/services/.

import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "src", "assets");
const dst = path.join(root, "dist", "assets");

await mkdir(dst, { recursive: true });
await cp(src, dst, { recursive: true, force: true });
process.stdout.write(`copy-assets: ${src} → ${dst}\n`);

// Copy the GDScript preflight script (tsc does not emit .cjs files)
const preflightSrc = path.join(root, "src", "services", "gdscript-preflight.cjs");
const preflightDst = path.join(root, "dist", "services", "gdscript-preflight.cjs");
await cp(preflightSrc, preflightDst, { force: true });
process.stdout.write(`copy-assets: ${preflightSrc} → ${preflightDst}\n`);
