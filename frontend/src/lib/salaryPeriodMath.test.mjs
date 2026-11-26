import test from "node:test";
import assert from "node:assert/strict";
import { monthSalaryWeeks } from "./salaryPeriodMath.mjs";

test("month salary weeks include partial first and final Monday-Saturday periods", () => {
  assert.deepEqual(monthSalaryWeeks("2026-11"), [
    { start: "2026-11-02", end: "2026-11-07" },
    { start: "2026-11-09", end: "2026-11-14" },
    { start: "2026-11-16", end: "2026-11-21" },
    { start: "2026-11-23", end: "2026-11-28" },
    { start: "2026-11-30", end: "2026-11-30" },
  ]);
});

test("month salary weeks cover a month starting on Monday", () => {
  assert.deepEqual(monthSalaryWeeks("2026-06"), [
    { start: "2026-06-01", end: "2026-06-06" },
    { start: "2026-06-08", end: "2026-06-13" },
    { start: "2026-06-15", end: "2026-06-20" },
    { start: "2026-06-22", end: "2026-06-27" },
    { start: "2026-06-29", end: "2026-06-30" },
  ]);
});
