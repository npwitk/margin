import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.DATA_DIR = await mkdtemp(path.join(tmpdir(), "margin-conf-"));
const { deadlineInstant, editionsFrom, offsetHours } = await import("./conferences.ts");

test("deadlines are read in the venue's timezone", () => {
  assert.equal(offsetHours("AoE"), -12);
  assert.equal(offsetHours("UTC+8"), 8);
  assert.equal(offsetHours("UTC-7"), -7);
  assert.equal(deadlineInstant("2026-01-15 23:59:59", "AoE"), "2026-01-16T11:59:59.000Z");
  assert.equal(deadlineInstant("2026-01-15 23:59:59", "UTC+8"), "2026-01-15T15:59:59.000Z");
  assert.equal(deadlineInstant("TBD", "AoE"), null);
});

test("each conference shows its next deadline, or its latest edition", () => {
  const now = Date.parse("2026-06-01T00:00:00Z");
  const raw = [
    {
      title: "CCS", description: "ACM Conference on Computer and Communications Security", sub: "SC",
      confs: [
        { year: 2026, timezone: "AoE", timeline: [{ deadline: "2026-01-14 23:59:59", comment: "First cycle" }, { deadline: "2026-04-29 23:59:59", comment: "Second cycle" }] },
        { year: 2027, timezone: "AoE", place: "Somewhere", timeline: [{ deadline: "2027-01-12 23:59:59" }, { deadline: "2026-09-01 23:59:59", comment: "Early" }] },
      ],
    },
    { title: "OLDCONF", description: "Past", confs: [{ year: 2025, timezone: "UTC", timeline: [{ deadline: "2025-03-01 12:00:00" }] }] },
  ];
  const [ccs, old] = editionsFrom(raw, now);
  assert.equal(ccs.name, "CCS");
  assert.equal(ccs.year, 2027);
  assert.equal(ccs.round, "Early");
  assert.equal(ccs.area, "Security");
  assert.equal(ccs.template, "acm-sigconf", "CCS uses the ACM format");
  assert.equal(old.year, 2025);
  assert.equal(old.template, undefined);
});
