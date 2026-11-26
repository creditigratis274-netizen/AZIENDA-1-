import test from "node:test";
import assert from "node:assert/strict";
import { calculateAttendanceHours } from "./attendanceHours.mjs";

test("weekday 08:00-18:00 is nine worked hours including one overtime hour", () => {
  assert.deepEqual(calculateAttendanceHours({
    date: "2026-11-13",
    start_time: "08:00",
    end_time: "18:00",
  }), { workedHours: 9, overtimeHours: 1 });
});

test("manual overtime replaces the automatic overtime value", () => {
  assert.deepEqual(calculateAttendanceHours({
    date: "2026-10-26",
    start_time: "08:00",
    end_time: "13:00",
    overtime_hours: 2,
  }), { workedHours: 5, overtimeHours: 2 });
});

test("Saturday has no lunch deduction and overtime remains after 17:00", () => {
  assert.deepEqual(calculateAttendanceHours({
    date: "2026-11-14",
    start_time: "08:00",
    end_time: "18:00",
  }), { workedHours: 10, overtimeHours: 1 });
});

test("weekday standard shift subtracts lunch but has no overtime", () => {
  assert.deepEqual(calculateAttendanceHours({
    date: "2026-11-13",
    start_time: "08:00",
    end_time: "17:00",
  }), { workedHours: 8, overtimeHours: 0 });
});
