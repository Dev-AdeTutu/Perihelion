#!/usr/bin/env node
// Fails if any entry in Slither's triage database lacks a written justification.
// A suppression with no rationale is how a real finding gets buried, so every
// triaged entry must carry detector, contract, description, and rationale.

import { readFileSync } from "node:fs";

const dbPath = process.argv[2] ?? "contracts/evm/slither.db.json";

/** @type {unknown} */
let parsed;
try {
  parsed = JSON.parse(readFileSync(dbPath, "utf8"));
} catch (err) {
  console.error(`::error::cannot read triage database ${dbPath}: ${err.message}`);
  process.exit(1);
}

if (typeof parsed !== "object" || parsed === null || !Array.isArray(parsed.findings)) {
  console.error(`::error::${dbPath} has no "findings" array`);
  process.exit(1);
}

const MIN_RATIONALE_LENGTH = 30;
const required = ["detector", "contract", "description"];
let failures = 0;

parsed.findings.forEach((finding, index) => {
  const label = `${dbPath}#findings[${index}]`;

  for (const field of required) {
    if (typeof finding?.[field] !== "string" || finding[field].trim() === "") {
      console.error(`::error::${label} is missing "${field}"`);
      failures += 1;
    }
  }

  const rationale = typeof finding?.rationale === "string" ? finding.rationale.trim() : "";
  if (rationale.length < MIN_RATIONALE_LENGTH) {
    console.error(
      `::error::${label} (${finding?.detector ?? "unknown detector"}) has no substantive justification; ` +
        `a rationale of at least ${MIN_RATIONALE_LENGTH} characters is required`
    );
    failures += 1;
  }
});

if (failures > 0) {
  console.error(`Slither triage audit failed: ${failures} problem(s).`);
  process.exit(1);
}

console.log(`Slither triage audit passed: ${parsed.findings.length} entries all justified.`);
