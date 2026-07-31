#!/usr/bin/env bun

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";

const TOP_LEVEL_COUNT_KEYS = [
  "requestedTransitions",
  "requestedRoundTrips",
  "completedRoundTrips",
  "completedTransitions",
  "warmupTransitions",
  "canvasMountCount",
  "hiddenWindowsChecked",
  "listenerBaseline",
  "listenerEnd",
  "listenerDelta",
  "listenerUnderflowCount",
];

const NETWORK_COUNT_GROUPS = [
  "joins",
  "streams",
  "fixtureTraffic",
  "interceptedFixtureTraffic",
  "stubUnhandled",
];

const THRESHOLD_KEY_PATTERN =
  /(?:threshold|tolerance|maximum|minimum|maxAddedEntries|maxLength)$/i;

function sortedRecord(value) {
  return Object.fromEntries(
    Object.entries(value ?? {}).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

function definedRecord(entries) {
  return Object.fromEntries(
    entries.filter(([, value]) => value !== undefined),
  );
}

function collectThresholds(value, path = [], output = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return output;
  }
  for (const [key, child] of Object.entries(value).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const childPath = [...path, key];
    if (
      THRESHOLD_KEY_PATTERN.test(key) &&
      (typeof child === "number" || typeof child === "boolean")
    ) {
      output[childPath.join(".")] = child;
      continue;
    }
    collectThresholds(child, childPath, output);
  }
  return output;
}

function assertionThresholds(assertions) {
  const output = {};
  for (const name of Object.keys(assertions ?? {}).sort()) {
    const percent = name.match(/AtMost(\d+)Percent$/);
    if (percent) {
      output[`assertions.${name}`] = Number(percent[1]) / 100;
    }
  }
  return output;
}

function violationCounts(summary) {
  return definedRecord([
    ["hiddenFrameViolations", summary.hiddenFrameViolations?.length],
    ["hiddenCameraViolations", summary.hiddenCameraViolations?.length],
    ["hiddenStoreViolations", summary.hiddenStoreViolations?.length],
    ["activeGrowthViolations", summary.activeGrowthViolations?.length],
    ["transitionErrors", summary.transitionErrors?.length],
    [
      "returnLoaderViolations",
      summary.routes?.returnLoaderViolations?.length,
    ],
    // Session 6 measured 3,2,2,2 on the exact same staging build and
    // instrument. These are WebGPU warmup snapshot deltas before the
    // steady-state inventory assertion takes over, not behavioral violations.
  ]);
}

function networkCounts(summary) {
  const network = summary.routes?.network;
  if (!network) return {};
  return definedRecord(
    NETWORK_COUNT_GROUPS.map((key) => [
      key,
      network[key] ? sortedRecord(network[key]) : undefined,
    ]),
  );
}

export function canonicalizeStageProbeSummary(summary) {
  const assertions = sortedRecord(summary.assertions);
  const assertionValues = Object.values(assertions);
  const thresholds = sortedRecord({
    ...collectThresholds(summary),
    ...assertionThresholds(assertions),
  });

  return {
    schema: "world-stage-probe-canonical-v2",
    identity: definedRecord([
      ["lane", summary.lane],
      ["pair", summary.pair],
      ["backend", summary.backend],
      ["experimentMode", summary.experiment?.mode],
    ]),
    verdict: {
      pass: summary.pass === true,
      assertions,
      counts: {
        total: assertionValues.length,
        passed: assertionValues.filter(Boolean).length,
        failed: assertionValues.filter((value) => !value).length,
      },
    },
    counts: {
      topLevel: definedRecord(
        TOP_LEVEL_COUNT_KEYS.map((key) => [key, summary[key]]),
      ),
      violations: violationCounts(summary),
      recovery: definedRecord([
        ["count", summary.recovery?.count],
        ["rendererAttempts", summary.recovery?.rendererAttempts],
      ]),
      network: networkCounts(summary),
    },
    thresholds,
  };
}

export function renderCanonicalStageProbeSummary(summary) {
  return `${JSON.stringify(canonicalizeStageProbeSummary(summary), null, 2)}\n`;
}

async function main() {
  const argv = new Map(
    process.argv.slice(2).map((raw) => {
      const [key, ...value] = raw.replace(/^--/, "").split("=");
      return [key, value.join("=") || "1"];
    }),
  );
  const input = argv.get("input");
  if (!input) {
    throw new Error(
      "Usage: world-stage-canonicalize.mjs --input=<summary.json> [--output=<canonical.json>]",
    );
  }
  const summary = JSON.parse(await readFile(resolve(input), "utf8"));
  const rendered = renderCanonicalStageProbeSummary(summary);
  const output = argv.get("output");
  if (output) {
    const outputPath = resolve(output);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, rendered, "utf8");
  } else {
    process.stdout.write(rendered);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
