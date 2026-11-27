import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  BadgeCheck, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight,
  Download, History, Search, SlidersHorizontal, Trash2, Wallet,
} from "lucide-react";
import { api, apiError } from "@/lib/api";
import { fmtMoney, today } from "@/lib/format";
import { isPieceworkTailor, moneyToCents, sumPayrollRows } from "@/lib/salaryReportMath.mjs";
import { monthSalaryWeeks } from "@/lib/salaryPeriodMath.mjs";
import { Badge, Btn, Card, Empty, Input, Modal, Select } from "@/components/common";
import { useAuth } from "@/context/AuthContext";

const mondayOf = (value) => {
  const date = new Date(String(value || today()) + "T00:00:00Z");
  const day = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - day);
  return date.toISOString().slice(0, 10);
};

const weekRange = (start) => {
  const monday = new Date(String(start || "") + "T00:00:00Z");
  if (!Number.isFinite(monday.getTime()) || monday.getUTCDay() !== 1) return null;
  const saturday = new Date(monday);
  saturday.setUTCDate(saturday.getUTCDate() + 5);
  return { start: monday.toISOString().slice(0, 10), end: saturday.toISOString().slice(0, 10) };
};

const monthRange = (month) => {
  if (!/^\d{4}-\d{2}$/.test(String(month || ""))) return null;
  const start = new Date(month + "-01T00:00:00Z");
  if (!Number.isFinite(start.getTime())) return null;
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
};

const addDays = (value, days) => {
  const date = new Date(String(value || "") + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};
const shiftMonth = (value, amount) => {
  const date = new Date(String(value || "") + "-01T00:00:00Z");
  date.setUTCMonth(date.getUTCMonth() + amount);
  return date.toISOString().slice(0, 7);
};
const isoWeek = (value) => {
  const date = new Date(String(value || "") + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
};
const isoWeekYear = (value) => {
  const date = new Date(String(value || "") + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
  return date.getUTCFullYear();
};
const calendarDays = (month) => {
  const first = new Date(month + "-01T00:00:00Z");
  const offset = (first.getUTCDay() + 6) % 7;
  const gridStart = new Date(first);
  gridStart.setUTCDate(first.getUTCDate() - offset);
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(gridStart);
    date.setUTCDate(gridStart.getUTCDate() + index);
    return date.toISOString().slice(0, 10);
  });
};
const displayDate = (value, options = { day: "2-digit", month: "short" }) =>
  new Intl.DateTimeFormat("en-GB", { ...options, timeZone: "UTC" })
    .format(new Date(String(value || "") + "T00:00:00Z"));
const displayMonth = (value) =>
  new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(String(value || "") + "-01T00:00:00Z"));

const cents = moneyToCents;
const monthlyEmployee = (employee) => employee?.pay_frequency === "monthly_fixed";
const payrollConfigFromEmployee = (employee) => ({
  pay_mode: employee?.pay_mode || (monthlyEmployee(employee) ? "monthly" : isPieceworkTailor(employee) ? "piecework" : "standard"),
  overtime_rate: employee?.overtime_rate == null ? "21" : String(employee.overtime_rate),
  pay_divisor: String(employee?.pay_divisor ?? 48),
  half_day_hours: String(employee?.half_day_hours ?? 5),
  piecework_formula: employee?.piecework_formula || "",
});
const employeeDepartment = (employee) => employee?.department || (employee?.is_general_worker ? "General Worker" : "Other");
const excelAttendanceValues = (employee, period) => Array.from({ length: 7 }, (_, index) => {
  const date = addDays(period.start, index);
  if (isPieceworkTailor(employee)) {
    const pieceDay = (employee.piece_days || []).find((day) => day.date === date);
    return pieceDay ? Number(pieceDay.pieces || 0) : "";
  }
  const attendanceDay = (employee.days || []).find((day) => day.date === date);
  if (!attendanceDay) return "";
  if (attendanceDay.status === "Present") return 1;
  if (attendanceDay.status === "Half Day") return 0.5;
  return 0;
});
const salaryDepartment = (employee) => employee?.is_general_worker ? "General Worker" : employeeDepartment(employee);
const periodKey = (type, start) => type === "monthly" ? "monthly:" + start.slice(0, 7) : "weekly:" + start;

const fetchPeriodPayments = async (period, periodType) => {
  const periods = [{
    period_type: periodType,
    period_start: period.start,
    period_end: period.end,
  }];
  if (periodType === "weekly") {
    const month = monthRange(period.start.slice(0, 7));
    if (month) periods.push({
      period_type: "monthly",
      period_start: month.start,
      period_end: month.end,
    });
  }
  const lists = await Promise.all(periods.map((paymentPeriod) =>
    api.getUncached("/salaries/payments", paymentPeriod),
  ));
  return lists.flat();
};

const weeklyPlanEmployees = (plan) => [
  ...(plan?.friday?.employees || []),
  ...(plan?.saturday?.employees || []),
];

const calculateReportTotals = (report, monthlyIncluded, periodType) => {
  const includedRows = (report?.employees || [])
    .filter((employee) => !monthlyEmployee(employee)
      || (monthlyIncluded[employee.employee_id] ?? periodType === "monthly"))
    .map((employee) => {
      const grossCents = cents(employee.gross_salary);
      const cutCents = cents(employee.cut);
      return {
        grossCents,
        cutCents,
        netCents: grossCents - cutCents,
      };
    });
  return sumPayrollRows(includedRows);
};

function PayrollEmployeeCard({
  row,
  periodType,
  expanded,
  onToggleExpanded,
  onIncludeChange,
  rateValue,
  onRateChange,
  configuration,
  onConfigurationChange,
  paymentDate,
  onPaymentDateChange,
  saving,
  onSaveRate,
  onAddAdvance,
  onCutBalance,
  onShowBalanceHistory,
  onMarkPaid,
}) {
  const { employee, payment, monthly, included, grossCents, cutCents, netCents } = row;
  const showPieces = isPieceworkTailor(employee);
  const initials = String(employee.name || "?")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
  const statusLabel = payment ? "Paid" : monthly && periodType !== "monthly"
    ? "Monthly" : !monthly && periodType !== "weekly" ? "Weekly overview" : "Pending";
  const statusClass = payment
    ? "border-emerald-200 bg-emerald-50 text-emerald-800"
    : statusLabel === "Pending"
      ? "border-amber-200 bg-amber-50 text-amber-900"
      : "border-slate-200 bg-slate-50 text-slate-600";

  return (
    <article
      className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-[0_3px_14px_rgba(15,23,42,0.035)] transition-shadow hover:shadow-[0_8px_24px_rgba(15,23,42,0.07)] sm:p-5"
      data-testid={"salary-row-" + employee.employee_id}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#e7f6f1] text-sm font-bold text-[#26705d]">
            {initials}
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="font-semibold text-slate-950">{employee.name}</h4>
              {employee.is_general_worker && <Badge cls="border-[#cae8dc] bg-[#eff9f4] text-[#34725c]">General Worker</Badge>}
              {employee.is_plastic_cleaning && <Badge cls="border-cyan-200 bg-cyan-50 text-cyan-700">Plastic cleaning</Badge>}
              {employee.is_machine_work && <Badge cls="border-indigo-200 bg-indigo-50 text-indigo-700">Machine work</Badge>}
              {employee.is_plastic_cutting && <Badge cls="border-orange-200 bg-orange-50 text-orange-700">Plastic cutting</Badge>}
              <Badge cls={statusClass}>{statusLabel}</Badge>
            </div>
            <p className="mt-1 truncate text-xs text-slate-500">
              {salaryDepartment(employee)}
              {employee.is_general_worker && employee.department ? " · " + employee.department : ""}
            </p>
            {employee.salary_rate_missing && <p className="mt-1 text-xs font-medium text-amber-800">Missing configured rate · not payable</p>}
            {employee.active === false && <p className="mt-1 text-xs text-slate-500">Inactive record</p>}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          {monthly && <label className="inline-flex shrink-0 items-center gap-2 text-xs font-medium text-slate-600">
            <input type="checkbox" checked={included} onChange={(event) => onIncludeChange(event.target.checked)} />
            Include
          </label>}
          <Btn variant="outline" className="h-9 rounded-lg px-3 text-xs" onClick={onAddAdvance} disabled={saving}>Add a balance</Btn>
          <Btn variant="outline" className="h-9 rounded-lg px-3 text-xs" onClick={onCutBalance} disabled={saving}>Cut balance</Btn>
          <Btn variant="outline" className="h-9 rounded-lg px-3 text-xs" onClick={onShowBalanceHistory} disabled={saving}>Balance cut/add history</Btn>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 border-y border-slate-100 py-4 sm:grid-cols-5 sm:gap-4">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Salary this period</p>
          <p className="mt-1 font-mono text-sm font-semibold tabular-nums text-slate-700 sm:text-base">{fmtMoney(grossCents / 100)}</p>
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Days attended</p>
          <p className="mt-1 text-sm font-semibold tabular-nums text-slate-700 sm:text-base">
            {showPieces ? `${employee.piece_days?.length || 0} days` : `${employee.present_days || 0} full · ${employee.half_days || 0} half`} · {Number(employee.overtime_hours || 0).toLocaleString("en-ZA", { maximumFractionDigits: 2 })} {Number(employee.overtime_hours || 0) === 1 ? "hour" : "hours"} overtime
          </p>
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Balance due</p>
          <p className="mt-1 font-mono text-sm font-semibold tabular-nums text-slate-700 sm:text-base">{fmtMoney(employee.balance || 0)}</p>
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Deductions</p>
          <p className="mt-1 font-mono text-sm font-semibold tabular-nums text-slate-700 sm:text-base">{fmtMoney(cutCents / 100)}</p>
        </div>
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Take-home salary</p>
          <p className="mt-1 font-mono text-sm font-bold tabular-nums text-slate-950 sm:text-base">{fmtMoney(netCents / 100)}</p>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <button type="button" onClick={() => onToggleExpanded()} className="inline-flex items-center gap-1.5 rounded-lg px-2 py-2 text-xs font-semibold text-slate-600 transition-colors hover:bg-slate-50 hover:text-slate-950" aria-expanded={expanded}>
          {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          {expanded ? "Hide payroll breakdown" : "Payroll breakdown"}
        </button>
        {payment
          ? <Badge cls="border-emerald-200 bg-emerald-50 text-emerald-800"><BadgeCheck size={14} className="mr-1" /> Paid {payment.payment_date}</Badge>
          : monthly && periodType !== "monthly"
            ? <span className="text-xs text-slate-500">Pay from Monthly view</span>
            : !monthly && periodType !== "weekly"
              ? <span className="text-xs text-slate-500">Pay from Week view</span>
              : <Btn className="min-w-24 rounded-lg !bg-slate-950 px-5 !text-white hover:!bg-slate-800" onClick={onMarkPaid} disabled={saving || !included || !!employee.salary_rate_missing || netCents <= 0}>
                <Check size={15} /> Pay
              </Btn>}
      </div>

      {expanded && <div className="mt-4 grid gap-4 border-t border-slate-100 pt-4 xl:grid-cols-3">
        <section className="space-y-3">
          <div>
            <h5 className="text-sm font-semibold text-slate-900">Payroll breakdown</h5>
            <p className="mt-1 text-xs text-slate-500">How this period’s gross pay was calculated.</p>
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-xl bg-slate-50 p-3"><p className="text-slate-500">Attendance pay</p><p className="mt-1 font-mono font-semibold">{fmtMoney(employee.regular_pay || 0)}</p></div>
            <div className="rounded-xl bg-slate-50 p-3"><p className="text-slate-500">Overtime</p><p className="mt-1 font-mono font-semibold">{Number(employee.overtime_hours || 0).toLocaleString("en-ZA", { maximumFractionDigits: 2 })} {Number(employee.overtime_hours || 0) === 1 ? "hour" : "hours"} overtime · {Number(employee.overtime_pay || 0).toLocaleString("en-ZA", { maximumFractionDigits: 2 })} ZAR</p></div>
            {showPieces ? <>
              <div className="rounded-xl bg-slate-50 p-3"><p className="text-slate-500">Piecework pay</p><p className="mt-1 font-mono font-semibold">{fmtMoney(employee.piece_pay || 0)}</p></div>
              <div className="rounded-xl bg-slate-50 p-3"><p className="text-slate-500">Recorded production</p><p className="mt-1 font-mono font-semibold">{employee.total_pieces || 0} pieces</p></div>
            </> : <>
              <div className="rounded-xl bg-slate-50 p-3"><p className="text-slate-500">Working days</p><p className="mt-1 font-mono font-semibold">{employee.present_days || 0} full · {employee.half_days || 0} half</p></div>
              <div className="rounded-xl bg-slate-50 p-3"><p className="text-slate-500">Hours worked this {periodType === "weekly" ? "week" : "month"} (lunch excluded)</p><p className="mt-1 font-mono font-semibold">{Number(employee.worked_hours ?? (Number(employee.regular_hours || 0) + Number(employee.overtime_hours || 0)))} hours</p></div>
            </>}
          </div>
          {employee.salary_rate_missing && <p role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950">No configured {monthly ? "monthly" : "weekly"} salary rate is available. Payroll is shown as R0.00 and cannot be marked paid.</p>}
        </section>

        <section className="space-y-3">
          <div>
            <h5 className="text-sm font-semibold text-slate-900">Salary &amp; balance</h5>
            <p className="mt-1 text-xs text-slate-500">Deductions are manual; nothing is taken automatically.</p>
          </div>
          {configuration.pay_mode !== "piecework" && <label className="block text-xs font-semibold text-slate-600">
            Configured {configuration.pay_mode === "monthly" ? "monthly" : "weekly"} salary
            <span className="mt-1 flex items-center gap-2">
              <span>R</span>
              <input type="number" min="0.01" step="0.01" value={rateValue} onChange={(event) => onRateChange(event.target.value)} disabled={saving || !!payment} className="min-w-0 flex-1 rounded-lg border border-slate-200 px-3 py-2 font-mono text-sm" />
            </span>
          </label>}
          <div className="grid gap-3 rounded-xl border border-slate-200 p-3 text-xs">
            <label className="font-semibold text-slate-600">
              Pay calculation mode
              <select value={configuration.pay_mode} onChange={(event) => onConfigurationChange("pay_mode", event.target.value)} disabled={saving || !!payment} className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-normal">
                <option value="standard">Standard, by hours</option>
                <option value="piecework">Piecework</option>
                <option value="monthly">Monthly fixed</option>
              </select>
            </label>
            <label className="font-semibold text-slate-600">
              Overtime rate (R/hour; blank uses legacy default)
              <input type="number" min="0" step="0.01" value={configuration.overtime_rate} onChange={(event) => onConfigurationChange("overtime_rate", event.target.value)} disabled={saving || !!payment} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-normal" />
            </label>
            {configuration.pay_mode !== "monthly" && <>
              {configuration.pay_mode !== "piecework" && <label className="font-semibold text-slate-600">
                Weekly salary divisor (typically 48)
                <input type="number" min="1" step="1" value={configuration.pay_divisor} onChange={(event) => onConfigurationChange("pay_divisor", event.target.value)} disabled={saving || !!payment} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-normal" />
              </label>}
              <label className="font-semibold text-slate-600">
                Half-day hours
                <input type="number" min="1" max="8" step="0.5" value={configuration.half_day_hours} onChange={(event) => onConfigurationChange("half_day_hours", event.target.value)} disabled={saving || !!payment} className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm font-normal" />
              </label>
            </>}
            {configuration.pay_mode === "piecework" && <label className="font-semibold text-slate-600">
              Piecework formula for this employee
              <select value={configuration.piecework_formula} onChange={(event) => onConfigurationChange("piecework_formula", event.target.value)} disabled={saving || !!payment} className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-normal">
                <option value="">Existing tiered production rules</option>
                {"ABCDEFGHIJKLMN".split("").map((formula, index) => <option key={formula} value={formula}>Profile {index + 1} ({formula})</option>)}
              </select>
            </label>}
            <p className="text-[11px] leading-5 text-slate-500">{payment
              ? payment.calculation_snapshot
                ? "This paid period is read-only and uses its saved calculation snapshot."
                : "This legacy paid period is read-only; its recorded amounts are preserved, but no calculation snapshot is available."
              : "These settings also apply when recalculating unpaid historical periods. Paid records keep their saved calculation snapshot."}</p>
          </div>
          <Btn className="w-full rounded-lg" disabled={saving || !!payment} onClick={onSaveRate}>Save rate &amp; calculation settings</Btn>
          <div className="grid grid-cols-2 gap-2 rounded-xl bg-slate-50 p-3 text-xs">
            <div><p className="text-slate-500">Balance at period start</p><p className="mt-1 font-mono font-semibold">{fmtMoney((employee.period_opening_balance ?? employee.balance_before_period) || 0)}</p></div>
            <div><p className="text-slate-500">Balance remaining after cut</p><p className="mt-1 font-mono font-semibold">{fmtMoney((employee.period_remaining_balance ?? employee.balance ?? employee.balance_after_period) || 0)}</p></div>
          </div>
          <div className="rounded-xl border border-slate-200 p-3 text-xs text-slate-600">
            <p className="font-semibold text-slate-800">Calculation rule</p>
            <p className="mt-1">
              {showPieces ? "Piecework" : monthly ? "Monthly fixed" : "Standard"} ·
              {!monthly && !showPieces && ` divisor ${employee.pay_divisor || 48}`}
            </p>
            <p className="mt-1">{employee.overtime_rate == null
              ? "Overtime fallback: R21/hour"
              : `Overtime rate: R${Number(employee.overtime_rate).toLocaleString("en-ZA", { minimumFractionDigits: 2 })}/hour`}</p>
            {!showPieces && <p className="mt-1">Half day: {Number(employee.half_day_hours ?? 5)} hours</p>}
            {showPieces && employee.piecework_formula && <p className="mt-1">Piecework formula: {employee.piecework_formula}</p>}
          </div>
        </section>

        <section className="space-y-3">
          <div>
            <h5 className="text-sm font-semibold text-slate-900">Payment</h5>
            <p className="mt-1 text-xs text-slate-500">Confirm the date and amount paid.</p>
          </div>
          {payment ? <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
            <p className="font-semibold"><BadgeCheck size={16} className="mr-1 inline" /> Payment recorded</p>
            <p className="mt-2">Paid on {payment.payment_date}</p>
            <p className="mt-1 font-mono text-lg font-semibold">{fmtMoney(payment.net_amount)}</p>
            <p className="mt-1 text-xs">This is the amount actually recorded as paid. Attendance and balance cuts recalculate the current take-home salary above, but do not change this payment record.</p>
            <p className="mt-1 text-xs">This record is locked and cannot be paid twice.</p>
          </div> : monthly && periodType !== "monthly"
            ? <p className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-xs text-slate-600">This employee can be paid once from the Monthly payroll.</p>
            : !monthly && periodType !== "weekly"
              ? <p className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-xs text-slate-600">Record payment from the specific weekly payroll.</p>
              : <div className="space-y-3 rounded-xl border border-slate-200 p-4">
                <Input label="Date paid" type="date" value={paymentDate} onChange={(event) => onPaymentDateChange(event.target.value)} disabled={saving} />
                <div><p className="text-xs text-slate-500">Take-home pay</p><p className="font-mono text-lg font-semibold text-slate-950">{fmtMoney(netCents / 100)}</p></div>
              </div>}
        </section>
      </div>}
    </article>
  );
}

export default function SalariesManagement() {
  const { user } = useAuth();
  const isSuperIqFoam = user?.company_id === "superiqfoam";
  const [periodType, setPeriodType] = useState("weekly");
  const [weekStart, setWeekStart] = useState(() => mondayOf(today()));
  const [monthValue, setMonthValue] = useState(() => today().slice(0, 7));
  const [monthWeekIndex, setMonthWeekIndex] = useState(() => {
    const month = today().slice(0, 7);
    const weeks = monthSalaryWeeks(month);
    const index = weeks.findIndex((week) => today() >= week.start && today() <= week.end);
    return index >= 0 ? index : 0;
  });
  const [report, setReport] = useState(null);
  const [payments, setPayments] = useState([]);
  const [weeklyPlan, setWeeklyPlan] = useState(null);
  const [weeklySalaryDrafts, setWeeklySalaryDrafts] = useState({});
  const [weeklyOvertimeDrafts, setWeeklyOvertimeDrafts] = useState({});
  const [weeklyOvertimeRateDrafts, setWeeklyOvertimeRateDrafts] = useState({});
  const [weeklyPlanSaving, setWeeklyPlanSaving] = useState(false);
  const [weeklyPaymentModal, setWeeklyPaymentModal] = useState(null);
  const [history, setHistory] = useState([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [historyCompanyId, setHistoryCompanyId] = useState(user?.company_id || "");
  const [view, setView] = useState("payroll");
  const [loading, setLoading] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [department, setDepartment] = useState("");
  const [expanded, setExpanded] = useState({});
  const [monthlyIncluded, setMonthlyIncluded] = useState({});
  const [cutDrafts, setCutDrafts] = useState({});
  const [rateDrafts, setRateDrafts] = useState({});
  const [configurationDrafts, setConfigurationDrafts] = useState({});
  const [paymentDates, setPaymentDates] = useState({});
  const [savingIds, setSavingIds] = useState({});
  const [tableDrafts, setTableDrafts] = useState({});
  const [totalWasRecalculated, setTotalWasRecalculated] = useState(false);
  const [advanceModal, setAdvanceModal] = useState(null);
  const [cutModal, setCutModal] = useState(null);
  const [balanceHistoryModal, setBalanceHistoryModal] = useState(null);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [calendarMonth, setCalendarMonth] = useState(() => today().slice(0, 7));
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [ribbonReportMode, setRibbonReportMode] = useState("week");
  const [ribbonDate, setRibbonDate] = useState(today());
  const [ribbonCustomStart, setRibbonCustomStart] = useState(() => mondayOf(today()));
  const [ribbonCustomEnd, setRibbonCustomEnd] = useState(() => addDays(mondayOf(today()), 5));
  const [ribbonReport, setRibbonReport] = useState(null);
  const [ribbonDrafts, setRibbonDrafts] = useState({});
  const [ribbonSaving, setRibbonSaving] = useState({});
  const [currentBalances, setCurrentBalances] = useState(null);
  const [currentBalancesOpen, setCurrentBalancesOpen] = useState(false);
  const [currentBalancesLoading, setCurrentBalancesLoading] = useState(false);
  const [currentBalancesRefreshedAt, setCurrentBalancesRefreshedAt] = useState("");

  const monthWeeks = useMemo(() => monthSalaryWeeks(monthValue), [monthValue]);
  const period = useMemo(() => {
    if (periodType === "monthly") return monthRange(monthValue);
    const selectedMonthWeek = monthWeeks[monthWeekIndex];
    return selectedMonthWeek ? selectedMonthWeek : weekRange(weekStart);
  }, [periodType, monthValue, monthWeekIndex, monthWeeks, weekStart]);
  const payrollKey = period ? periodKey(periodType, period.start) : "";
  useEffect(() => {
    if (periodType === "weekly" && monthWeeks[monthWeekIndex]) {
      setWeekStart(monthWeeks[monthWeekIndex].start);
    }
  }, [periodType, monthWeekIndex, monthWeeks]);
  const weeklySplitView = false;
  const calendarGrid = useMemo(() => calendarDays(calendarMonth), [calendarMonth]);
  const selectedSunday = addDays(weekStart, 6);
  const selectedMonthWeekNumber = periodType === "weekly" ? monthWeekIndex + 1 : 0;
  const selectedWeekNumber = selectedMonthWeekNumber || isoWeek(weekStart);
  const selectedWeekYear = isoWeekYear(weekStart);

  const openCalendar = () => {
    setCalendarMonth(periodType === "weekly" ? weekStart.slice(0, 7) : monthValue);
    setCalendarOpen((current) => !current);
  };
  const selectCalendarDate = (value) => {
    if (periodType === "weekly") {
      const month = value.slice(0, 7);
      const weeks = monthSalaryWeeks(month);
      const index = weeks.findIndex((week) => value >= week.start && value <= week.end);
      setMonthValue(month);
      setMonthWeekIndex(index >= 0 ? index : 0);
      setWeekStart(index >= 0 ? mondayOf(weeks[index].start) : mondayOf(value));
    } else {
      setMonthValue(value.slice(0, 7));
    }
    setCalendarOpen(false);
  };

  const reload = async ({ showLoading = true, resetExpanded = true } = {}) => {
    if (!period) {
      toast.error(periodType === "weekly" ? "Choose a Monday for the weekly payroll." : "Choose a valid calendar month.");
      return;
    }
    if (showLoading) setLoading(true);
    try {
      const params = {
        start_date: period.start,
        end_date: period.end,
        include_monthly_salaries: true,
      };
      const [nextReport, nextPayments, nextWeeklyPlan] = await Promise.all([
        api.getUncached("/salaries", params),
        fetchPeriodPayments(period, periodType).catch(() => []),
        isSuperIqFoam && periodType === "weekly"
          ? api.getUncached("/salaries/weekly-plan", {
            period_start: period.start,
            period_end: period.end,
          }).catch(() => null)
          : Promise.resolve(null),
      ]);
      setReport(nextReport);
      setPayments(nextPayments || []);
      setWeeklyPlan(nextWeeklyPlan);
      setWeeklySalaryDrafts(Object.fromEntries(weeklyPlanEmployees(nextWeeklyPlan).map((employee) => [
        employee.employee_id, String(employee.weekly_salary ?? ""),
      ])));
      setWeeklyOvertimeDrafts(Object.fromEntries(weeklyPlanEmployees(nextWeeklyPlan).map((employee) => [
        employee.employee_id, String(employee.overtime_hours ?? 0),
      ])));
      setWeeklyOvertimeRateDrafts(Object.fromEntries(weeklyPlanEmployees(nextWeeklyPlan).map((employee) => [
        employee.employee_id, String(employee.overtime_rate ?? 21),
      ])));
      const paidByEmployee = Object.fromEntries((nextPayments || []).map((payment) => [payment.employee_id, payment]));
      setCutDrafts(Object.fromEntries((nextReport.employees || []).map((employee) => [
        employee.employee_id, String(paidByEmployee[employee.employee_id]?.deduction_amount ?? employee.cut ?? 0),
      ])));
      setRateDrafts(Object.fromEntries((nextReport.employees || []).map((employee) => [
        employee.employee_id,
        String(monthlyEmployee(employee) ? (employee.monthly_salary ?? "") : (employee.weekly_salary ?? "")),
      ])));
      setConfigurationDrafts(Object.fromEntries((nextReport.employees || []).map((employee) => [
        employee.employee_id, payrollConfigFromEmployee(employee),
      ])));
      setMonthlyIncluded((current) => Object.fromEntries((nextReport.employees || [])
        .filter(monthlyEmployee)
        .map((employee) => [
          employee.employee_id,
          Object.hasOwn(current, employee.employee_id)
            ? current[employee.employee_id]
            : periodType === "monthly",
        ])));
      if (resetExpanded) setExpanded({});
      return { report: nextReport, payments: nextPayments || [] };
    } catch (error) {
      toast.error(apiError(error));
      return null;
    } finally {
      if (showLoading) setLoading(false);
    }
  };

  useEffect(() => {
    let active = true;
    if (!period) {
      setReport(null);
      setPayments([]);
      setWeeklyPlan(null);
      setWeeklySalaryDrafts({});
      setWeeklyOvertimeDrafts({});
      setWeeklyOvertimeRateDrafts({});
      setLoading(false);
      return () => { active = false; };
    }
    setReport(null);
    setPayments([]);
    setWeeklyPlan(null);
    setWeeklySalaryDrafts({});
    setWeeklyOvertimeDrafts({});
    setWeeklyOvertimeRateDrafts({});
    setMonthlyIncluded({});
    setCutDrafts({});
    setRateDrafts({});
    setConfigurationDrafts({});
    setPaymentDates({});
    setTotalWasRecalculated(false);
    setAdvanceModal(null);
    setLoading(true);
    const params = {
      start_date: period.start,
      end_date: period.end,
      include_monthly_salaries: true,
    };
    Promise.all([
      api.getUncached("/salaries", params),
      fetchPeriodPayments(period, periodType).catch(() => []),
      isSuperIqFoam && periodType === "weekly"
        ? api.getUncached("/salaries/weekly-plan", {
          period_start: period.start,
          period_end: period.end,
        }).catch(() => null)
        : Promise.resolve(null),
    ]).then(([nextReport, nextPayments, nextWeeklyPlan]) => {
      if (!active) return;
      setReport(nextReport);
      setPayments(nextPayments || []);
      setWeeklyPlan(nextWeeklyPlan);
      setWeeklySalaryDrafts(Object.fromEntries(weeklyPlanEmployees(nextWeeklyPlan).map((employee) => [
        employee.employee_id, String(employee.weekly_salary ?? ""),
      ])));
      setWeeklyOvertimeDrafts(Object.fromEntries(weeklyPlanEmployees(nextWeeklyPlan).map((employee) => [
        employee.employee_id, String(employee.overtime_hours ?? 0),
      ])));
      setWeeklyOvertimeRateDrafts(Object.fromEntries(weeklyPlanEmployees(nextWeeklyPlan).map((employee) => [
        employee.employee_id, String(employee.overtime_rate ?? 21),
      ])));
      const paidByEmployee = Object.fromEntries((nextPayments || []).map((payment) => [payment.employee_id, payment]));
      setCutDrafts(Object.fromEntries((nextReport.employees || []).map((employee) => [
        employee.employee_id, String(paidByEmployee[employee.employee_id]?.deduction_amount ?? employee.cut ?? 0),
      ])));
      setRateDrafts(Object.fromEntries((nextReport.employees || []).map((employee) => [
        employee.employee_id,
        String(monthlyEmployee(employee) ? (employee.monthly_salary ?? "") : (employee.weekly_salary ?? "")),
      ])));
      setConfigurationDrafts(Object.fromEntries((nextReport.employees || []).map((employee) => [
        employee.employee_id, payrollConfigFromEmployee(employee),
      ])));
      setMonthlyIncluded((current) => Object.fromEntries((nextReport.employees || [])
        .filter(monthlyEmployee)
        .map((employee) => [
          employee.employee_id,
          Object.hasOwn(current, employee.employee_id)
            ? current[employee.employee_id]
            : periodType === "monthly",
        ])));
      setExpanded({});
    }).catch((error) => {
      if (active) toast.error(apiError(error));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [period?.start, period?.end, periodType, user?.company_id, isSuperIqFoam]);

  const ribbonPeriod = useMemo(() => {
    if (ribbonReportMode === "day") return { start: ribbonDate, end: ribbonDate };
    if (ribbonReportMode === "month") return monthRange(ribbonDate.slice(0, 7));
    if (ribbonReportMode === "custom") {
      if (ribbonCustomEnd >= ribbonCustomStart) return { start: ribbonCustomStart, end: ribbonCustomEnd };
      return null;
    }
    const weekStart = mondayOf(ribbonDate);
    return { start: weekStart, end: addDays(weekStart, 5) };
  }, [ribbonReportMode, ribbonDate, ribbonCustomStart, ribbonCustomEnd]);

  useEffect(() => {
    if (view !== "ribbon" || !ribbonPeriod) return;
    let active = true;
    api.getUncached("/salaries", {
      start_date: ribbonPeriod.start,
      end_date: ribbonPeriod.end,
      include_monthly_salaries: false,
    }).then((nextReport) => {
      if (active) setRibbonReport(nextReport);
      if (active) setRibbonDrafts(Object.fromEntries((nextReport?.employees || [])
        .filter(isPieceworkTailor)
        .map((employee) => [employee.employee_id, String((employee.piece_days || []).find((day) => day.date === ribbonDate)?.pieces ?? "")])));
    }).catch((error) => {
      if (active) toast.error(apiError(error));
    });
    return () => { active = false; };
  }, [view, ribbonPeriod, ribbonDate, user?.company_id]);

  useEffect(() => {
    if (view !== "history" || (historyLoaded && historyCompanyId === user?.company_id)) return;
    let active = true;
    setHistoryLoading(true);
    api.getUncached("/salaries/payments/history")
      .then((items) => {
        if (active) {
          setHistory(items || []);
          setHistoryLoaded(true);
          setHistoryCompanyId(user?.company_id || "");
        }
      })
      .catch((error) => { if (active) toast.error(apiError(error)); })
      .finally(() => { if (active) setHistoryLoading(false); });
    return () => { active = false; };
  }, [view, historyLoaded, historyCompanyId, user?.company_id]);

  const refreshAllCurrentBalances = async () => {
    if (currentBalancesLoading) return;
    setCurrentBalancesLoading(true);
    try {
      // Reuse the existing salary report calculation. Its "balance" field
      // is the cumulative outstanding total (all advances minus all cuts).
      const currentDate = today();
      const currentWeekStart = mondayOf(currentDate);
      const currentWeekEnd = addDays(currentWeekStart, 5);
      const result = await api.getUncached("/salaries", {
        start_date: currentWeekStart,
        end_date: currentWeekEnd,
        include_monthly_salaries: true,
      });
      setCurrentBalances(result?.employees || []);
      setCurrentBalancesRefreshedAt(new Date().toLocaleString());
      setCurrentBalancesOpen(true);
      toast.success("All current employee balances refreshed.");
    } catch (error) {
      toast.error("Could not refresh all current balances: " + apiError(error));
    } finally {
      setCurrentBalancesLoading(false);
    }
  };

  const paymentByEmployee = useMemo(() => Object.fromEntries(
    (report?.employees || []).map((employee) => {
      const expectedType = periodType === "monthly" || monthlyEmployee(employee) ? "monthly" : "weekly";
      const payment = (payments || []).find((item) =>
        item.employee_id === employee.employee_id && item.period_type === expectedType,
      ) || null;
      return [employee.employee_id, payment];
    }),
  ), [payments, report, periodType]);
  const rows = useMemo(() => (report?.employees || []).map((employee) => {
    const payment = paymentByEmployee[employee.employee_id] || null;
    const monthly = payment ? payment.period_type === "monthly" : monthlyEmployee(employee);
    const included = !monthly || (monthlyIncluded[employee.employee_id] ?? periodType === "monthly");
    const snapshot = payment?.calculation_snapshot;
    const displayEmployee = snapshot ? { ...employee, ...snapshot } : employee;
    const grossCents = cents(payment?.gross_amount ?? employee.gross_salary);
    const cutCents = cents(payment?.deduction_amount ?? employee.cut);
    return {
      employee: displayEmployee,
      monthly,
      included,
      grossCents,
      cutCents,
      netCents: payment?.net_amount != null ? cents(payment.net_amount) : grossCents - cutCents,
      payment,
    };
  }).sort((a, b) => {
    const fixedNameA = /^(AMEENA|YASSINE)$/i.test(String(a.employee.name || "").trim());
    const fixedNameB = /^(AMEENA|YASSINE)$/i.test(String(b.employee.name || "").trim());
    if (fixedNameA !== fixedNameB) return fixedNameA ? 1 : -1;
    return salaryDepartment(a.employee).localeCompare(salaryDepartment(b.employee))
      || String(a.employee.name || "").localeCompare(String(b.employee.name || ""));
  }), [report, monthlyIncluded, periodType, paymentByEmployee]);

  const reportRows = rows.filter((row) => row.included);
  const totals = sumPayrollRows(reportRows);
  const includedPaidRows = reportRows.filter((row) => row.payment);
  const paidCents = includedPaidRows.reduce((sum, row) => sum + cents(row.payment.net_amount), 0);
  const paidGrossCents = includedPaidRows.reduce((sum, row) => sum + cents(row.payment.gross_amount), 0);
  const departments = [...new Set(rows.map(({ employee }) => salaryDepartment(employee)))]
    .sort((a, b) => a.localeCompare(b));
  const filteredRows = rows.filter(({ employee }) =>
    (department === "" || salaryDepartment(employee) === department)
    && (String(employee.name || "") + " " + String(employee.employee_id || "") + " " + salaryDepartment(employee) + " " + employeeDepartment(employee))
      .toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
  );

  const changePeriodType = (nextType) => {
    setPeriodType(nextType);
    if (nextType === "weekly") {
      const weeks = monthSalaryWeeks(monthValue);
      const index = weeks.findIndex((week) => today() >= week.start && today() <= week.end);
      setMonthWeekIndex(index >= 0 ? index : 0);
    }
    setView("payroll");
    setSearch("");
    setDepartment("");
  };

  const saveRate = async (employee) => {
    const config = configurationDrafts[employee.employee_id] || payrollConfigFromEmployee(employee);
    const rateText = String(rateDrafts[employee.employee_id] ?? "").trim();
    const amount = Number(rateText);
    if (rateText && (!Number.isFinite(amount) || amount <= 0)) {
      return toast.error("Enter a salary rate greater than zero, or leave it blank to keep it unchanged.");
    }
    const overtimeRate = config.overtime_rate === "" ? null : Number(config.overtime_rate);
    const divisor = Number(config.pay_divisor);
    const halfDayHours = Number(config.half_day_hours);
    if (overtimeRate !== null && (!Number.isFinite(overtimeRate) || overtimeRate < 0)) {
      return toast.error("Overtime rate must be zero or greater.");
    }
    if (config.pay_mode !== "monthly" && config.pay_mode !== "piecework"
      && (!Number.isFinite(divisor) || divisor < 1)) {
      return toast.error("Salary divisor must be at least one.");
    }
    if (config.pay_mode !== "monthly"
      && (!Number.isFinite(halfDayHours) || halfDayHours < 1 || halfDayHours > 8)) {
      return toast.error("Half-day hours must be between one and eight.");
    }
    if (config.pay_mode === "monthly" && !rateText && employee.monthly_salary == null) {
      return toast.error("Enter a monthly salary before switching to monthly fixed pay.");
    }
    setSavingIds((current) => ({ ...current, [employee.employee_id]: true }));
    try {
      const payload = {
        pay_mode: config.pay_mode,
        overtime_rate: overtimeRate,
        pay_divisor: config.pay_mode === "monthly" ? undefined : divisor,
        half_day_hours: config.pay_mode === "monthly" ? undefined : halfDayHours,
        piecework_formula: config.piecework_formula || null,
      };
      if (rateText) {
        if (config.pay_mode === "monthly") payload.monthly_salary = amount;
        else if (config.pay_mode !== "piecework") payload.weekly_salary = amount;
      }
      await api.put("/salaries/rates/" + employee.employee_id, payload);
      toast.success("Salary and calculation settings saved for " + employee.name);
      await reload();
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setSavingIds((current) => ({ ...current, [employee.employee_id]: false }));
    }
  };

  const saveWeeklySalary = async (employee) => {
    const value = String(weeklySalaryDrafts[employee.employee_id] ?? "").trim();
    const salary = Number(value);
    if (!value || !Number.isFinite(salary) || salary <= 0) {
      return toast.error("Enter a fixed weekly salary greater than zero.");
    }
    setSavingIds((current) => ({ ...current, [employee.employee_id]: true }));
    try {
      await api.put("/salaries/rates/" + employee.employee_id, { weekly_salary: salary });
      toast.success("Fixed weekly salary saved for " + employee.employee_name);
      await reload({ showLoading: false, resetExpanded: false });
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setSavingIds((current) => ({ ...current, [employee.employee_id]: false }));
    }
  };

  const saveWeeklyOvertime = async (employee) => {
    const hoursText = String(weeklyOvertimeDrafts[employee.employee_id] ?? "").trim();
    const rateText = String(weeklyOvertimeRateDrafts[employee.employee_id] ?? "").trim();
    const hours = Number(hoursText);
    const rate = Number(rateText);
    if (!hoursText || !Number.isFinite(hours) || hours < 0 || hours > 168) {
      return toast.error("Overtime hours must be between 0 and 168.");
    }
    if (!rateText || !Number.isFinite(rate) || rate < 0) {
      return toast.error("Overtime rate must be zero or greater.");
    }
    if (employee.salary_rate_missing) {
      return toast.error("Save the fixed weekly salary before setting overtime.");
    }
    setSavingIds((current) => ({ ...current, [employee.employee_id]: true }));
    try {
      await api.put("/salaries/weekly-overtime", {
        employee_id: employee.employee_id,
        period_start: period.start,
        period_end: period.end,
        overtime_hours: hours,
        overtime_rate: rate,
      });
      toast.success("Overtime saved and payroll recalculated for " + employee.employee_name);
      await reload({ showLoading: false, resetExpanded: false });
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setSavingIds((current) => ({ ...current, [employee.employee_id]: false }));
    }
  };

  const saveTableSalary = async (employee, value) => {
    const salary = Number(value);
    if (!Number.isFinite(salary) || salary <= 0) return toast.error("Enter a salary greater than zero.");
    setSavingIds((current) => ({ ...current, [employee.employee_id]: true }));
    try {
      await api.put("/salaries/rates/" + employee.employee_id, { weekly_salary: salary });
      await reload({ showLoading: false, resetExpanded: false });
      toast.success("Weekly salary saved.");
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setSavingIds((current) => ({ ...current, [employee.employee_id]: false }));
    }
  };

  const saveTableOvertime = async (employee, hoursValue, rateValue) => {
    const overtimeHours = Number(hoursValue);
    const overtimeRate = Number(rateValue);
    if (!Number.isFinite(overtimeHours) || overtimeHours < 0 || overtimeHours > 168) {
      return toast.error("Overtime hours must be between 0 and 168.");
    }
    if (!Number.isFinite(overtimeRate) || overtimeRate < 0) return toast.error("Overtime rate must be zero or greater.");
    if (!period) return toast.error("Choose a valid pay period first.");
    setSavingIds((current) => ({ ...current, [employee.employee_id]: true }));
    try {
      await api.put("/salaries/weekly-overtime", {
        employee_id: employee.employee_id,
        period_start: period.start,
        period_end: period.end,
        overtime_hours: overtimeHours,
        overtime_rate: overtimeRate,
      });
      await reload({ showLoading: false, resetExpanded: false });
      toast.success("Overtime hours and rate saved.");
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setSavingIds((current) => ({ ...current, [employee.employee_id]: false }));
    }
  };

  const saveTableAttendance = async (employee, date, value) => {
    const normalized = String(value ?? "").trim().toLowerCase();
    const status = normalized === "1" || normalized === "x" ? "Present"
      : normalized === "0.5" ? "Half Day"
        : normalized === "0" ? "Absent"
          : "";
    if (!status) return toast.error("Use 1, 0.5, x or 0 for attendance.");
    setSavingIds((current) => ({ ...current, [employee.employee_id]: true }));
    try {
      await api.post("/attendance", {
        employee_id: employee.employee_id,
        date,
        status,
        overtime_hours: normalized === "0" ? 0 : undefined,
      });
      await reload({ showLoading: false, resetExpanded: false });
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setSavingIds((current) => ({ ...current, [employee.employee_id]: false }));
    }
  };

  const saveRibbonProduction = async (employee, date, value) => {
    const pieces = Number(value);
    if (!Number.isInteger(pieces) || pieces < 0) return toast.error("Pieces must be a whole number of zero or more.");
    setRibbonSaving((current) => ({ ...current, [employee.employee_id]: true }));
    try {
      await api.post("/piece-production", { employee_id: employee.employee_id, date, pieces });
      toast.success(`Production saved for ${employee.name}`);
      setRibbonDrafts((current) => ({ ...current, [employee.employee_id]: String(pieces) }));
      const nextReport = await api.getUncached("/salaries", {
        start_date: ribbonPeriod.start,
        end_date: ribbonPeriod.end,
        include_monthly_salaries: false,
      });
      setRibbonReport(nextReport);
      await reload({ showLoading: false, resetExpanded: false });
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setRibbonSaving((current) => ({ ...current, [employee.employee_id]: false }));
    }
  };

  const saveTableProduction = async (employee, date, value) => {
    const pieces = Number(value);
    if (!Number.isInteger(pieces) || pieces < 0) return toast.error("Pieces must be a whole number of zero or more.");
    setSavingIds((current) => ({ ...current, [employee.employee_id]: true }));
    try {
      await api.post("/piece-production", { employee_id: employee.employee_id, date, pieces });
      await reload({ showLoading: false, resetExpanded: false });
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setSavingIds((current) => ({ ...current, [employee.employee_id]: false }));
    }
  };

  const saveTableCut = async (employee, value) => {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0) return toast.error("Balance cut must be zero or greater.");
    setSavingIds((current) => ({ ...current, [employee.employee_id]: true }));
    try {
      await api.post("/salaries/cuts", {
        employee_id: employee.employee_id,
        start_date: period.start,
        end_date: period.end,
        amount,
        notes: "Entered in Salary table",
      });
      await reload({ showLoading: false, resetExpanded: false });
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setSavingIds((current) => ({ ...current, [employee.employee_id]: false }));
    }
  };

  const updateBalanceHistoryModal = (nextReport, employeeId) => {
    if (!balanceHistoryModal) return;
    const updatedEmployee = (nextReport?.employees || []).find((item) => item.employee_id === employeeId);
    if (updatedEmployee) {
      setBalanceHistoryModal({
        ...updatedEmployee,
        name: updatedEmployee.name || employeeId,
        employee_name: updatedEmployee.name || employeeId,
      });
    }
  };

  const saveCut = async (employee, details = cutModal) => {
    if (monthlyEmployee(employee) && periodType !== "monthly") {
      toast.error("Select the complete month to save a monthly balance deduction.");
      return false;
    }
    if (!monthlyEmployee(employee) && periodType !== "weekly") {
      toast.error("Select a Monday–Saturday week to save this employee's deduction.");
      return false;
    }
    const amount = Number(details?.amount ?? cutDrafts[employee.employee_id] ?? employee.cut ?? 0);
    if (!Number.isFinite(amount) || amount <= 0) {
      toast.error("Enter a cut amount greater than zero.");
      return false;
    }
    const currentRate = monthlyEmployee(employee) ? employee.monthly_salary : employee.weekly_salary;
    if (cents(rateDrafts[employee.employee_id]) !== cents(currentRate)) {
      toast.error("Save the salary rate before saving a deduction.");
      return false;
    }
    if (amount > Number(employee.gross_salary || 0)) {
      toast.error("Deduction cannot exceed this employee's gross salary.");
      return false;
    }
    setSavingIds((current) => ({ ...current, [employee.employee_id]: true }));
    try {
      await api.post("/salaries/cuts", {
        employee_id: employee.employee_id,
        start_date: period.start,
        end_date: period.end,
        amount,
        notes: details?.notes || "",
      });
      toast.success("Manual balance deduction saved.");
      setCutDrafts((current) => ({ ...current, [employee.employee_id]: String(amount) }));
      setCutModal(null);
      const reloaded = await reload({ showLoading: false, resetExpanded: false });
      updateBalanceHistoryModal(reloaded?.report, employee.employee_id);
      return true;
    } catch (error) {
      toast.error(apiError(error));
      return false;
    } finally {
      setSavingIds((current) => ({ ...current, [employee.employee_id]: false }));
    }
  };

  const saveAdvance = async () => {
    if (!advanceModal || !(Number(advanceModal.amount) > 0)) return toast.error("Enter an amount greater than zero.");
    try {
      const savedAdvance = await api.post("/salaries/advances", {
        ...advanceModal,
        amount: Number(advanceModal.amount),
      });
      // Update the live balance cell immediately from the server-confirmed
      // outstanding balance; the period opening/remaining balances stay intact.
      if (Number.isFinite(Number(savedAdvance?.balance))) {
        setReport((current) => current ? ({
          ...current,
          employees: (current.employees || []).map((employee) =>
            employee.employee_id === advanceModal.employee_id
              ? {
                  ...employee,
                  balance: Number(savedAdvance.balance),
                  available_balance: Number(savedAdvance.available_balance ?? savedAdvance.balance),
                }
              : employee
          ),
        }) : current);
      }
      toast.success("Borrowed balance added. Current balance updated immediately.");
      setAdvanceModal(null);
      const reloaded = await reload({ showLoading: false, resetExpanded: false });
      updateBalanceHistoryModal(reloaded?.report, advanceModal.employee_id);
    } catch (error) {
      toast.error(apiError(error));
    }
  };

  const clearBalanceHistory = async () => {
    if (!balanceHistoryModal) return;
    const employee = balanceHistoryModal;
    if (!employee.balance_history?.length) return;
    const confirmed = window.confirm(
      "Delete all balance additions and cuts for " + employee.name
      + "? This resets the outstanding balance to zero. The change will be recorded in the audit history.",
    );
    if (!confirmed) return;
    setSavingIds((current) => ({ ...current, [employee.employee_id]: true }));
    try {
      await api.del("/salaries/history/" + employee.employee_id);
      toast.success("Balance history cleared for " + employee.name);
      const refreshed = await reload({ showLoading: false, resetExpanded: false });
      const updatedEmployee = refreshed?.report?.employees?.find(
        (item) => item.employee_id === employee.employee_id,
      );
      if (updatedEmployee) setBalanceHistoryModal(updatedEmployee);
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setSavingIds((current) => ({ ...current, [employee.employee_id]: false }));
    }
  };

  const markPaid = async (row) => {
    const employee = row.employee;
    if (!row.included) return toast.error("Include this monthly employee in the report before recording payment.");
    if (row.payment) return toast.error("This payroll has already been marked as paid.");
    const currentRate = row.monthly ? employee.monthly_salary : employee.weekly_salary;
    if (cents(rateDrafts[employee.employee_id]) !== cents(currentRate)) {
      return toast.error("Save the salary rate before marking this payroll as paid.");
    }
    if (cents(cutDrafts[employee.employee_id]) !== cents(employee.cut)) {
      return toast.error("Save the balance deduction before marking this payroll as paid.");
    }
    if (row.monthly && periodType !== "monthly") {
      return toast.error("Select the monthly payroll to record this employee's payment.");
    }
    if (!row.monthly && periodType !== "weekly") {
      return toast.error("Weekly employees must be paid from a Monday–Saturday payroll.");
    }
    const paymentDate = paymentDates[employee.employee_id] || today();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(paymentDate)) return toast.error("Choose a valid payment date.");
    const label = row.monthly ? "monthly" : "weekly";
    const confirmed = window.confirm(
      "Record " + fmtMoney(row.netCents / 100) + " as paid to " + employee.name
      + " for this " + label + " payroll on " + paymentDate + "? This cannot be recorded twice.",
    );
    if (!confirmed) return;
    const previousGrossCents = totals.grossCents;
    setSavingIds((current) => ({ ...current, [employee.employee_id]: true }));
    try {
      const paymentPeriod = row.monthly
        ? monthRange(monthValue)
        : period;
      await api.post("/salaries/payments", {
        employee_id: employee.employee_id,
        period_type: row.monthly ? "monthly" : "weekly",
        period_start: paymentPeriod.start,
        period_end: paymentPeriod.end,
        payment_date: paymentDate,
      });
      toast.success("Payment recorded for " + employee.name);
      setHistoryLoaded(false);
      const refreshed = await reload({ showLoading: false, resetExpanded: false });
      if (refreshed) {
        const recalculatedTotals = calculateReportTotals(
          refreshed.report,
          monthlyIncluded,
          periodType,
        );
        setTotalWasRecalculated(recalculatedTotals.grossCents !== previousGrossCents);
      }
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setSavingIds((current) => ({ ...current, [employee.employee_id]: false }));
    }
  };

  const updateWeeklyFridaySelection = async (employeeId, assignFriday) => {
    if (!isSuperIqFoam || !period || periodType !== "weekly" || weeklyPlanSaving) return;
    const fridayIds = new Set(weeklyPlan?.friday_employee_ids || []);
    if (assignFriday) fridayIds.add(employeeId);
    else fridayIds.delete(employeeId);
    setWeeklyPlanSaving(true);
    try {
      const updatedPlan = await api.put("/salaries/weekly-plan", {
        period_start: period.start,
        period_end: period.end,
        friday_employee_ids: [...fridayIds],
      });
      setWeeklyPlan(updatedPlan);
      toast.success(assignFriday ? "Assigned to Friday payment group" : "Assigned to Saturday payment group");
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setWeeklyPlanSaving(false);
    }
  };

  const recordWeeklySalaryPayment = async () => {
    if (!weeklyPaymentModal || !period) return;
    const amountText = String(weeklyPaymentModal.amount || "").trim();
    if (!/^\d+(?:\.\d{1,2})?$/.test(amountText)) {
      return toast.error("Enter an amount with no more than two decimal places.");
    }
    const amount = Number(amountText);
    const amountCents = cents(amount);
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
      return toast.error("Enter an amount greater than zero.");
    }
    if (amountCents > weeklyPaymentModal.employee.remaining_cents) {
      return toast.error("Payment cannot exceed the remaining salary balance.");
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weeklyPaymentModal.paymentDate)) {
      return toast.error("Choose a valid payment date.");
    }
    const employeeId = weeklyPaymentModal.employee.employee_id;
    setSavingIds((current) => ({ ...current, [employeeId]: true }));
    try {
      await api.post("/salaries/weekly-payments", {
        employee_id: employeeId,
        period_start: period.start,
        period_end: period.end,
        payment_date: weeklyPaymentModal.paymentDate,
        amount: amountCents / 100,
        idempotency_key: globalThis.crypto?.randomUUID?.() || `${employeeId}-${Date.now()}-${Math.random()}`,
        notes: weeklyPaymentModal.notes || "",
      });
      toast.success(`Payment recorded for ${weeklyPaymentModal.employee.employee_name}`);
      setWeeklyPaymentModal(null);
      setHistoryLoaded(false);
      await reload({ showLoading: false, resetExpanded: false });
    } catch (error) {
      toast.error(apiError(error));
    } finally {
      setSavingIds((current) => ({ ...current, [employeeId]: false }));
    }
  };

  const downloadReport = async () => {
    if (!period || !report) return toast.error("Load a valid payroll period first.");
    try {
      const { jsPDF } = await import("jspdf");
      const pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const margin = 12;
      const colWidths = [47, 35, 24, 30, 30, 28, 31, 27];
      const headers = ["EMPLOYEE", "DEPARTMENT", "TYPE", "DAYS / PIECES", "GROSS", "DEDUCTION", "NET PAYABLE", "STATUS"];
      let y = 16;
      const periodTitle = periodType === "monthly" ? "Monthly salary report" : "Weekly salary report";
      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(17);
      pdf.setTextColor(27, 48, 39);
      pdf.text(periodTitle, margin, y);
      y += 7;
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(9);
      pdf.setTextColor(92, 102, 94);
      pdf.text("Pay period: " + period.start + " to " + period.end, margin, y);
      pdf.text("Generated: " + today(), pageWidth - margin, y, { align: "right" });
      y += 9;
      const totalsLabels = [
        ["GROSS PAY", fmtMoney(totals.grossCents / 100)],
        ["BALANCE DEDUCTIONS", fmtMoney(totals.cutCents / 100)],
        ["NET PAYABLE", fmtMoney(totals.netCents / 100)],
      ];
      const cardWidth = (pageWidth - margin * 2 - 8) / 3;
      totalsLabels.forEach((metric, index) => {
        const x = margin + index * (cardWidth + 4);
        pdf.setFillColor(index === 2 ? 31 : 246, index === 2 ? 58 : 246, index === 2 ? 46 : 239);
        pdf.roundedRect(x, y, cardWidth, 15, 2, 2, "F");
        pdf.setTextColor(index === 2 ? 255 : 93, index === 2 ? 255 : 101, index === 2 ? 255 : 92);
        pdf.setFontSize(7);
        pdf.setFont("helvetica", "bold");
        pdf.text(metric[0], x + 3, y + 5);
        pdf.setFontSize(10);
        pdf.text(metric[1], x + 3, y + 11.5);
      });
      y += 22;
      const tableWidth = colWidths.reduce((sum, width) => sum + width, 0);
      const drawHeader = () => {
        pdf.setFillColor(26, 50, 40);
        pdf.rect(margin, y, tableWidth, 9, "F");
        pdf.setFont("helvetica", "bold");
        pdf.setFontSize(6.5);
        pdf.setTextColor(255, 255, 255);
        let x = margin;
        headers.forEach((header, index) => {
          pdf.text(header, x + 2, y + 5.8);
          x += colWidths[index];
        });
        y += 9;
      };
      drawHeader();
      for (const row of reportRows) {
        if (y > pageHeight - 12) {
          pdf.addPage("a4", "landscape");
          y = 15;
          drawHeader();
        }
        const employee = row.employee;
        const showPieces = isPieceworkTailor(employee);
        const basis = row.monthly
          ? "Monthly"
          : showPieces
            ? String(employee.total_pieces || 0) + " pieces"
            : String(employee.present_days || 0) + " full / " + String(employee.half_days || 0) + " half";
        const values = [
          employee.name || "Unnamed",
          salaryDepartment(employee),
          row.monthly ? "Monthly" : (showPieces ? "Piecework" : "Weekly"),
          basis,
          fmtMoney(row.grossCents / 100),
          fmtMoney(row.cutCents / 100),
          fmtMoney(row.netCents / 100),
          row.payment ? "PAID " + row.payment.payment_date : "PENDING",
        ];
        pdf.setFillColor(255, 255, 255);
        pdf.rect(margin, y, tableWidth, 8, "F");
        pdf.setDrawColor(222, 224, 218);
        pdf.line(margin, y + 8, margin + tableWidth, y + 8);
        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(6.5);
        pdf.setTextColor(40, 49, 43);
        let x = margin;
        values.forEach((value, index) => {
          pdf.text(String(value).slice(0, 34), x + 2, y + 5.2);
          x += colWidths[index];
        });
        y += 8;
      }
      const keyLabel = payrollKey.replace(":", "-");
      pdf.save("salary-report-" + keyLabel + ".pdf");
      toast.success("Salary report downloaded.");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : apiError(error));
    }
  };

  return (
    <div className="mx-auto max-w-7xl space-y-6 pb-6" data-testid="salary-management">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#39806b]">Payroll Management</p>
          <h2 className="mt-1 font-display text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">Salaries</h2>
          <p className="mt-2 text-sm text-slate-500">Manage employee salaries and payroll periods.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Btn variant={view === "payroll" ? "primary" : "outline"} className="rounded-xl" onClick={() => setView("payroll")} data-testid="salary-view-payroll"><Wallet size={15} /> Payroll</Btn>
          <Btn variant={view === "ribbon" ? "primary" : "outline"} className="rounded-xl" onClick={() => setView("ribbon")} data-testid="salary-view-ribbon"><Wallet size={15} /> Ribbon piecework</Btn>
          <Btn variant={view === "history" ? "primary" : "outline"} className="rounded-xl" onClick={() => setView("history")} data-testid="salary-view-history"><History size={15} /> Payment history</Btn>
          {view === "payroll" && <Btn variant="outline" className="rounded-xl" disabled={currentBalancesLoading} onClick={refreshAllCurrentBalances} data-testid="salary-refresh-all-current-balances"><History size={15} /> {currentBalancesLoading ? "Refreshing balances..." : "Refresh all current balances"}</Btn>}
          {view === "payroll" && <Btn variant="outline" className="rounded-xl" disabled={loading || !report} onClick={reload} data-testid="salary-refresh"><History size={15} /> Recalculate</Btn>
          {view === "payroll" && <Btn className="rounded-xl bg-slate-950 text-white hover:bg-slate-800" disabled={loading || !report || !reportRows.length} onClick={downloadReport} data-testid="salary-download-report"><Download size={15} /> Download report</Btn>}
        </div>
      </div>

      {view === "payroll" ? <>
        <section className="relative rounded-3xl border border-slate-200/80 bg-white p-4 shadow-[0_8px_32px_rgba(15,23,42,0.045)] sm:p-6" aria-label="Pay period selector">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <button type="button" onClick={() => {
              const month = today().slice(0, 7);
              const weeks = monthSalaryWeeks(month);
              const index = weeks.findIndex((week) => today() >= week.start && today() <= week.end);
              setMonthValue(month);
              setMonthWeekIndex(index >= 0 ? index : 0);
              setWeekStart(index >= 0 ? weeks[index].start : mondayOf(today()));
              if (periodType === "monthly") setMonthValue(month);
            }} className="hidden rounded-lg px-3 py-2 text-xs font-semibold text-[#34725c] transition-colors hover:bg-[#eff9f4]" data-testid="salary-today">Today</button>
          </div>

          <div className="mt-5 flex items-center justify-center gap-2 sm:mt-6 sm:gap-4">
            <button
              type="button"
              onClick={() => periodType === "weekly"
                ? monthWeekIndex > 0
                  ? setMonthWeekIndex((current) => current - 1)
                  : (() => { const month = shiftMonth(monthValue, -1); setMonthValue(month); setMonthWeekIndex(Math.max(0, monthSalaryWeeks(month).length - 1)); })()
                : setMonthValue(shiftMonth(monthValue, -1))}
              aria-label={periodType === "weekly" ? "Previous week" : "Previous month"}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-slate-200 text-slate-600 transition-colors hover:border-[#cbe7db] hover:bg-[#f1faf6] hover:text-[#286a56]"
            ><ChevronLeft size={18} /></button>
            <div className="min-w-0 flex-1 text-center sm:flex-none sm:min-w-[280px]">
              <p className="truncate text-lg font-semibold tracking-tight text-slate-950 sm:text-2xl" data-testid="salary-period-label">
                {periodType === "weekly"
                  ? `${displayDate(period?.start)} – ${displayDate(period?.end)}`
                  : displayMonth(monthValue)}
              </p>
              <p className="mt-1 text-xs font-medium text-slate-500">
                {periodType === "weekly" ? `Settimana ${selectedMonthWeekNumber} di ${displayMonth(monthValue)} · ${monthWeeks.length} settimane nel mese` : "Full calendar month"}
              </p>
            </div>
            <button
              type="button"
              onClick={() => periodType === "weekly"
                ? monthWeekIndex < monthWeeks.length - 1
                  ? setMonthWeekIndex((current) => current + 1)
                  : (() => { const month = shiftMonth(monthValue, 1); setMonthValue(month); setMonthWeekIndex(0); })()
                : setMonthValue(shiftMonth(monthValue, 1))}
              aria-label={periodType === "weekly" ? "Next week" : "Next month"}
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-slate-200 text-slate-600 transition-colors hover:border-[#cbe7db] hover:bg-[#f1faf6] hover:text-[#286a56]"
            ><ChevronRight size={18} /></button>
            <div className="relative">
              <button type="button" onClick={openCalendar} aria-label="Open calendar" aria-expanded={calendarOpen} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-slate-200 text-slate-600 transition-colors hover:border-[#cbe7db] hover:bg-[#f1faf6] hover:text-[#286a56]" data-testid="salary-calendar-toggle"><CalendarDays size={18} /></button>
              {calendarOpen && <div className="absolute right-0 top-12 z-30 w-[min(22rem,calc(100vw-2rem))] rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_18px_50px_rgba(15,23,42,0.16)]" data-testid="salary-calendar">
                <div className="flex items-center justify-between gap-3">
                  <button type="button" onClick={() => setCalendarMonth(shiftMonth(calendarMonth, -1))} aria-label="Previous calendar month" className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"><ChevronLeft size={17} /></button>
                  <h3 className="text-sm font-semibold text-slate-950">{displayMonth(calendarMonth)}</h3>
                  <button type="button" onClick={() => setCalendarMonth(shiftMonth(calendarMonth, 1))} aria-label="Next calendar month" className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"><ChevronRight size={17} /></button>
                </div>
                <div className="mt-3 grid grid-cols-7 text-center text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                  {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => <span key={day} className="py-2">{day}</span>)}
                </div>
                <div className="grid grid-cols-7 gap-y-1">
                  {calendarGrid.map((date) => {
                    const inMonth = date.slice(0, 7) === calendarMonth;
                    const inSelectedWeek = periodType === "weekly" && mondayOf(date) === weekStart;
                    const selected = periodType === "weekly" ? inSelectedWeek : date === monthValue + "-01";
                    const isToday = date === today();
                    return <button
                      type="button"
                      key={date}
                      onClick={() => selectCalendarDate(date)}
                      aria-label={displayDate(date, { day: "numeric", month: "long", year: "numeric" })}
                      aria-pressed={selected}
                      className={"relative mx-auto flex h-9 w-9 items-center justify-center rounded-full text-xs transition-colors "
                        + (selected ? "bg-[#dff2e9] font-bold text-[#276b56] "
                          : inSelectedWeek ? "rounded-lg bg-[#f0f8f4] text-[#34725c] "
                            : "text-slate-700 hover:bg-slate-100 ")
                        + (!inMonth ? "text-slate-300 " : "")
                        + (isToday && !selected ? "font-bold ring-1 ring-[#8fc8ad] " : "")}
                      data-testid={"salary-calendar-day-" + date}
                    >{Number(date.slice(-2))}</button>;
                  })}
                </div>
                <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-3">
                  <span className="text-[11px] text-slate-500">{periodType === "weekly" ? "Select any date to choose its week" : "Select any date to choose its month"}</span>
                  <button type="button" onClick={() => { selectCalendarDate(today()); setCalendarMonth(today().slice(0, 7)); }} className="rounded-lg px-3 py-1.5 text-xs font-semibold text-[#34725c] hover:bg-[#eff9f4]">Today</button>
                </div>
              </div>}
            </div>
          </div>

          {periodType === "weekly" && <div className="mt-5 flex flex-wrap gap-2" aria-label="Month salary weeks">
            {monthWeeks.map((week, index) => <button
              type="button"
              key={week.start}
              onClick={() => { setMonthWeekIndex(index); setWeekStart(week.start); }}
              aria-pressed={monthWeekIndex === index}
              className={"rounded-lg border px-3 py-2 text-xs font-semibold transition-colors " + (monthWeekIndex === index
                ? "border-[#34725c] bg-[#34725c] text-white"
                : "border-slate-200 bg-white text-slate-600 hover:border-[#cbe7db] hover:bg-[#f1faf6]")}
              data-testid={`salary-month-week-${index + 1}`}
            >Settimana {index + 1}</button>)}
          </div>}

          {periodType === "weekly" && <div className="mt-3 grid grid-cols-7 gap-1.5 sm:mt-4 sm:gap-2" aria-label="Selected week days">
            {period && Array.from({ length: 7 }, (_, index) => {
              const date = addDays(period.start, index);
              if (date > period.end) return null;
              return <button type="button" key={date} onClick={() => { setCalendarMonth(date.slice(0, 7)); setCalendarOpen(true); }} className="min-w-0 rounded-xl bg-[#eff8f3] px-1 py-2 text-center transition-colors hover:bg-[#dff2e9] sm:px-2 sm:py-2.5" data-testid={"salary-week-day-" + date}>
                <span className="block text-[9px] font-semibold uppercase tracking-wide text-[#6b8f80] sm:text-[10px]">{displayDate(date, { weekday: "short" })}</span>
                <span className="mt-0.5 block text-xs font-semibold tabular-nums text-[#315d4c] sm:text-sm">{Number(date.slice(-2))}</span>
              </button>;
            })}
          </div>}
        </section>

        {period && <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5" aria-label="Salary period KPIs">
          <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-[0_5px_16px_rgba(15,23,42,0.06)]"><p className="text-[10px] font-bold uppercase text-slate-500">Period</p><p className="mt-1 text-sm font-bold text-slate-950">{displayDate(period.start)} – {displayDate(period.end)}</p></div>
          <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-[0_5px_16px_rgba(15,23,42,0.06)]"><p className="text-[10px] font-bold uppercase text-slate-500">Total employees</p><p className="mt-1 text-2xl font-bold tabular-nums text-slate-950">{rows.length}</p></div>
          <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-[0_5px_16px_rgba(15,23,42,0.06)]"><p className="text-[10px] font-bold uppercase text-slate-500">Total output</p><p className="mt-1 text-2xl font-bold tabular-nums text-slate-950">{fmtMoney(totals.grossCents / 100)}</p></div>
          <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-[0_5px_16px_rgba(15,23,42,0.06)]"><p className="text-[10px] font-bold uppercase text-slate-500">Final payment made</p><p className="mt-1 text-2xl font-bold tabular-nums text-slate-950">{fmtMoney(paidCents / 100)}</p></div>
          <div className="rounded-lg border border-slate-200 bg-[#f5f7ff] px-4 py-3 shadow-[0_5px_16px_rgba(15,23,42,0.06)]"><p className="text-[10px] font-bold uppercase text-[#314b8f]">Payment progress</p><p className="mt-1 text-2xl font-bold tabular-nums text-[#1d3477]">{rows.length ? Math.round(includedPaidRows.length / rows.length * 100) : 0}%</p></div>
        </section>}

        {period && <section className="overflow-hidden rounded-lg border border-slate-300 bg-white shadow-[0_8px_24px_rgba(15,23,42,0.08)]" aria-label="Excel salary table">
          <div className="overflow-x-auto">
            <table className="min-w-[1500px] border-collapse text-[11px] text-slate-950" data-testid="salary-excel-table">
              <thead>
                <tr className="bg-[#dce8ff] text-center font-bold">
                  <th className="w-12 border border-slate-400 px-2 py-2">S/N</th>
                  <th className="w-44 border border-slate-400 px-2 py-2">EMPLOYEE NAME</th>
                  <th className="w-44 border border-slate-400 px-2 py-2">DEPARTMENTS</th>
                  <th className="w-20 border border-slate-400 px-2 py-2">SALARY R</th>
                  <th className="w-20 border border-slate-400 px-2 py-2">OVERTIME HOURS</th>
                  <th className="w-20 border border-slate-400 px-2 py-2">OVERTIME RATE</th>
                  <th className="w-20 border border-slate-400 px-2 py-2">BALANCE</th>
                  <th className="w-20 border border-slate-400 px-2 py-2">WORKING HOURS</th>
                  <th className="w-20 border border-slate-400 px-2 py-2">WORKING DAYS</th>
                  <th className="w-20 border border-slate-400 px-2 py-2">TOTAL</th>
                  <th className="w-20 border border-slate-400 px-2 py-2">BALANCE CUT</th>
                  <th className="w-24 border border-slate-400 px-2 py-2">FINAL PAYMENT MADE</th>
                  {["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"].map((day) => <th key={day} className="w-16 border border-slate-400 px-2 py-2">{day}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => {
                  const employee = row.employee;
                  const salaryCents = cents(employee.weekly_salary || employee.monthly_salary || 0);
                  const automaticOvertimeHours = (employee.days || []).reduce(
                    (sum, day) => sum + Number(day.overtime_hours || 0),
                    0,
                  );
                  const values = excelAttendanceValues(employee, period);
                  return <tr key={employee.employee_id} className="text-center">
                    <td className="border border-slate-300 px-2 py-1 tabular-nums">{index + 1}</td>
                    <td className="border border-slate-300 px-2 py-1 text-left font-bold text-[#2633a0]">{employee.name}</td>
                    <td className="border border-slate-300 px-2 py-1 font-bold text-[#2633a0]">{salaryDepartment(employee)}</td>
                    <td className="border border-slate-300 px-1 py-1 font-mono">
                      <input
                        type="number" min="0.01" step="0.01"
                        value={tableDrafts[employee.employee_id + ":salary"] ?? (salaryCents / 100 || "")}
                        onChange={(event) => setTableDrafts((current) => ({ ...current, [employee.employee_id + ":salary"]: event.target.value }))}
                        onBlur={(event) => saveTableSalary(employee, event.target.value)}
                        disabled={!!row.payment || !!savingIds[employee.employee_id]}
                        className="w-16 bg-transparent px-1 text-center outline-none"
                        aria-label={`Salary for ${employee.name}`}
                      />
                    </td>
                    <td className="border border-slate-300 px-1 py-1 font-mono">
                      <input
                        type="number" min="0" max="168" step="0.25"
                        value={tableDrafts[employee.employee_id + ":overtime_hours"] ?? (employee.days || []).reduce((sum, day) => sum + Number(day.salary_overtime_override ?? day.overtime_hours ?? 0), 0)}
                        onChange={(event) => setTableDrafts((current) => ({ ...current, [employee.employee_id + ":overtime_hours"]: event.target.value }))}
                        onBlur={(event) => saveTableOvertime(employee, event.target.value, tableDrafts[employee.employee_id + ":overtime_rate"] ?? (employee.overtime_rate ?? 21))}
                        disabled={!!row.payment || !!savingIds[employee.employee_id]}
                        className="w-16 bg-transparent px-1 text-center outline-none"
                        aria-label={`Overtime hours for ${employee.name}`}
                        title="Edit weekly overtime hours"
                      />
                    </td>
                    <td className="border border-slate-300 px-1 py-1 font-mono">
                      <input
                        type="number" min="0" step="0.01"
                        value={tableDrafts[employee.employee_id + ":overtime_rate"] ?? (employee.overtime_rate ?? 21)}
                        onChange={(event) => setTableDrafts((current) => ({ ...current, [employee.employee_id + ":overtime_rate"]: event.target.value }))}
                        onBlur={(event) => saveTableOvertime(employee, automaticOvertimeHours, event.target.value)}
                        disabled={!!row.payment || !!savingIds[employee.employee_id]}
                        className="w-16 bg-transparent px-1 text-center outline-none"
                        aria-label={`Overtime rate for ${employee.name}`}
                      />
                    </td>
                    <td className="border border-slate-300 px-1 py-1 font-mono">
                      <button
                        type="button"
                        onClick={() => setAdvanceModal({ employee_id: employee.employee_id, employee_name: employee.name, amount: "", date: today(), notes: "" })}
                        className="w-full px-1 py-1 text-center text-[#2633a0] hover:underline"
                        title="Add balance"
                      >{employee.balance || 0}</button>
                    </td>
                    <td className="border border-slate-300 px-2 py-1 font-mono">{employee.worked_hours || 0}</td>
                    <td className="border border-slate-300 px-2 py-1 font-mono">{Number(employee.present_days || 0) + Number(employee.half_days || 0) * 0.5}</td>
                    <td className="border border-slate-300 px-2 py-1 font-mono font-bold">{employee.gross_salary || 0}</td>
                    <td className="border border-slate-300 px-1 py-1 font-mono text-red-700">
                      <input
                        type="number" min="0" step="0.01"
                        value={tableDrafts[employee.employee_id + ":cut"] ?? (employee.cut || 0)}
                        onChange={(event) => setTableDrafts((current) => ({ ...current, [employee.employee_id + ":cut"]: event.target.value }))}
                        onBlur={(event) => saveTableCut(employee, event.target.value)}
                        disabled={!!row.payment || !!savingIds[employee.employee_id]}
                        className="w-16 bg-transparent px-1 text-center text-red-700 outline-none"
                        aria-label={`Balance cut for ${employee.name}`}
                      />
                    </td>
                    <td className="border border-slate-300 px-1 py-1 font-mono font-bold">
                      {row.payment
                        ? fmtMoney(row.payment.net_amount)
                        : <button
                            type="button"
                            onClick={() => {
                              if (isSuperIqFoam) {
                                const dueCents = cents(employee.net_salary) * 1;
                                setWeeklyPaymentModal({
                                  employee: {
                                    employee_id: employee.employee_id,
                                    employee_name: employee.name,
                                    due_cents: dueCents,
                                    remaining_cents: dueCents,
                                  },
                                  paymentDate: period.start ? addDays(period.start, 5) : today(),
                                  amount: String(dueCents / 100),
                                  notes: "",
                                });
                              } else {
                                markPaid(row);
                              }
                            }}
                            disabled={!!savingIds[employee.employee_id] || Number(employee.net_salary || 0) <= 0}
                            className="w-full rounded bg-slate-950 px-2 py-1 text-[10px] font-bold text-white disabled:cursor-not-allowed disabled:opacity-40"
                          >PAY</button>}
                    </td>
                    {values.map((value, dayIndex) => {
                      const date = addDays(period.start, dayIndex);
                      const draftKey = employee.employee_id + ":day:" + date;
                      return <td key={dayIndex} className="border border-slate-300 px-1 py-1 font-mono">
                        {isPieceworkTailor(employee)
                          ? <input
                              type="number" min="0" step="1"
                              value={tableDrafts[draftKey] ?? (value === "" ? 0 : value)}
                              onChange={(event) => setTableDrafts((current) => ({ ...current, [draftKey]: event.target.value }))}
                              onBlur={(event) => saveTableProduction(employee, date, event.target.value)}
                              disabled={!!row.payment || !!savingIds[employee.employee_id]}
                              className="w-12 bg-transparent px-1 text-center outline-none"
                              aria-label={`Pieces for ${employee.name} on ${date}`}
                            />
                          : <select
                              value={tableDrafts[draftKey] ?? (value === 1 ? "1" : value === 0.5 ? "0.5" : value === 0 ? "0" : "")}
                              onChange={(event) => {
                                setTableDrafts((current) => ({ ...current, [draftKey]: event.target.value }))
                                saveTableAttendance(employee, date, event.target.value);
                              }}
                              disabled={!!row.payment || !!savingIds[employee.employee_id]}
                              className="w-12 bg-transparent text-center outline-none"
                              aria-label={`Attendance for ${employee.name} on ${date}`}
                            >
                              <option value="">-</option>
                              <option value="1">1</option>
                              <option value="0.5">0.5</option>
                              <option value="x">x</option>
                              <option value="0">0</option>
                            </select>}
                      </td>;
                    })}
                  </tr>;
                })}
              </tbody>
              <tfoot>
                <tr className="bg-[#0f5b87] text-center font-bold text-white">
                  <td className="border border-slate-300 px-2 py-2" colSpan={3}>TOTALS</td>
                  <td className="border border-slate-300 px-2 py-2 font-mono">{fmtMoney(rows.reduce((sum, row) => sum + cents(row.employee.weekly_salary || row.employee.monthly_salary || 0), 0) / 100)}</td>
                  <td className="border border-slate-300 px-2 py-2">{rows.reduce((sum, row) => sum + Number(row.employee.overtime_hours || 0), 0)}</td>
                  <td className="border border-slate-300 px-2 py-2 font-mono">{fmtMoney(rows.reduce((sum, row) => sum + cents(row.employee.overtime_pay), 0) / 100)}</td>
                  <td className="border border-slate-300 px-2 py-2 font-mono">{fmtMoney(rows.reduce((sum, row) => sum + cents(row.employee.balance), 0) / 100)}</td>
                  <td className="border border-slate-300 px-2 py-2">{rows.reduce((sum, row) => sum + Number(row.employee.worked_hours || 0), 0)}</td>
                  <td className="border border-slate-300 px-2 py-2">{rows.reduce((sum, row) => sum + Number(row.employee.present_days || 0) + Number(row.employee.half_days || 0) * 0.5, 0)}</td>
                  <td className="border border-slate-300 px-2 py-2 font-mono">{fmtMoney(totals.grossCents / 100)}</td>
                  <td className="border border-slate-300 px-2 py-2 font-mono">{fmtMoney(totals.cutCents / 100)}</td>
                  <td className="border border-slate-300 px-2 py-2 font-mono">{fmtMoney(totals.netCents / 100)}</td>
                  {[0, 1, 2, 3, 4, 5, 6].map((day) => <td key={day} className="border border-slate-300 px-2 py-2">—</td>)}
                </tr>
              </tfoot>
            </table>
          </div>
        </section>}

        {weeklySplitView ? weeklyPlan ? <section className="space-y-4" aria-label="Weekly salary payment summary" data-testid="weekly-salary-payment-summary">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#39806b]">WEEKLY SALARY PAYMENT SUMMARY</p>
            <p className="mt-1 text-xs text-slate-500">Cycle {weeklyPlan.period_start} – {weeklyPlan.period_end} · Friday {weeklyPlan.friday_date} · Saturday {weeklyPlan.saturday_date}</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {[
              ["Total Friday salaries", weeklyPlan.friday.due_cents],
              ["Total Saturday salaries", weeklyPlan.saturday.due_cents],
              ["Total weekly salaries", weeklyPlan.total_salaries_cents],
              ["Cash required Friday", weeklyPlan.friday.cash_required_cents],
              ["Cash required Saturday", weeklyPlan.saturday.cash_required_cents],
              ["Actually paid Friday", weeklyPlan.friday.actually_paid_cents],
              ["Actually paid Saturday", weeklyPlan.saturday.actually_paid_cents],
              ["Total actually paid", weeklyPlan.total_paid_cents],
              ["Outstanding balance", weeklyPlan.outstanding_cents],
            ].map(([label, amount]) => <div key={label} className="rounded-2xl border border-slate-200 bg-white p-4" data-testid={`weekly-summary-${label.toLowerCase().replaceAll(" ", "-")}`}>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
              <p className="mt-2 font-mono text-xl font-bold tabular-nums text-slate-950">{fmtMoney(Number(amount || 0) / 100)}</p>
            </div>)}
          </div>
        </section> : <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900" role="alert">
          Weekly payment assignments are unavailable. Reload the payroll before recording a payment.
        </div> : <section className="hidden overflow-hidden rounded-3xl bg-[#111312] p-5 text-white shadow-[0_16px_40px_rgba(15,23,42,0.16)] sm:p-7" aria-label="Payroll summary">
          <div className="grid gap-5 sm:grid-cols-3 sm:gap-0">
            <div className="sm:px-5 sm:first:pl-0">
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-white/55">Total salaries</p>
              <p className="mt-2 font-mono text-2xl font-semibold tabular-nums sm:text-3xl">{fmtMoney(totals.grossCents / 100)}</p>
              <p className="mt-1 text-xs text-white/45">Net payable {fmtMoney(totals.netCents / 100)}</p>
            </div>
            <div className="border-t border-white/10 pt-5 sm:border-l sm:border-t-0 sm:px-6 sm:pt-0">
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-white/55">Employees included</p>
              <p className="mt-2 font-mono text-2xl font-semibold tabular-nums sm:text-3xl">{report ? reportRows.length : "—"}</p>
              <p className="mt-1 text-xs text-white/45">{report ? `of ${rows.length} employees in this report` : "Loading payroll report"}</p>
            </div>
            <div className="border-t border-white/10 pt-5 sm:border-l sm:border-t-0 sm:px-6 sm:pt-0">
              <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-white/55">Settled</p>
              <p className="mt-2 font-mono text-2xl font-semibold tabular-nums sm:text-3xl">{includedPaidRows.length}</p>
              <p className="mt-1 text-xs text-white/45">{fmtMoney(paidGrossCents / 100)} salary · {fmtMoney(paidCents / 100)} net paid</p>
            </div>
          </div>
        </section>}

        {totalWasRecalculated && <p role="status" className="text-xs text-amber-800" data-testid="salary-total-recalculated">
          Please recalculate salaries. The total shown before payment was incorrect and has been updated.
        </p>}

        {weeklySplitView ? <section className="hidden space-y-5" aria-label="Friday and Saturday salary groups">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h3 className="font-display text-xl font-semibold text-slate-950">Friday &amp; Saturday payments</h3>
              <p className="mt-1 text-xs text-slate-500">PAY assigns a worker to Friday. All others are scheduled for Saturday. Assignment never marks a salary as paid.</p>
            </div>
            <Input type="search" label="Search employee" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name or employee ID" data-testid="salary-search" />
          </div>
          {weeklyPlan ? <div className="grid gap-4 xl:grid-cols-2">
            {[
              { key: "friday", title: "FRIDAY", group: weeklyPlan.friday, date: weeklyPlan.friday_date },
              { key: "saturday", title: "SATURDAY", group: weeklyPlan.saturday, date: weeklyPlan.saturday_date },
            ].map(({ key, title, group, date }) => {
              const dateCaption = date === today()
                ? `${title} – TODAY`
                : date === addDays(today(), 1)
                  ? `${title} – TOMORROW`
                  : `${title} – ${displayDate(date, { weekday: "long", day: "2-digit", month: "short" })}`;
              const visibleEmployees = group.employees.filter((employee) =>
                (department === "" || salaryDepartment(employee) === department)
                && (`${employee.employee_name} ${employee.employee_id} ${employee.department || ""}`)
                  .toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()),
              );
              return <Card key={key} className="overflow-hidden p-0" data-testid={`salary-group-${key}`}>
                <header className="flex flex-wrap items-end justify-between gap-3 border-b border-slate-200 bg-slate-50 p-5">
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#39806b]">{dateCaption}</p>
                    <p className="mt-1 text-xs text-slate-500">{group.employee_count} employees · Salary total {fmtMoney(group.due_cents / 100)}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Cash required</p>
                    <p className="font-mono text-2xl font-bold tabular-nums text-slate-950">{fmtMoney(group.cash_required_cents / 100)}</p>
                  </div>
                </header>
                {visibleEmployees.length === 0
                  ? <p className="p-5 text-sm text-slate-500">No employees in this group match the search.</p>
                  : <div className="divide-y divide-slate-100">
                    {visibleEmployees.map((employee) => {
                      const paymentsForEmployee = employee.payment_history || [];
                      const hasPayment = employee.paid_cents > 0;
                      const statusClass = employee.payment_status === "Paid"
                        ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                        : employee.payment_status === "Partially Paid"
                          ? "border-orange-200 bg-orange-50 text-orange-800"
                          : employee.payment_status === "Scheduled"
                            ? "border-sky-200 bg-sky-50 text-sky-800"
                            : "border-amber-200 bg-amber-50 text-amber-900";
                      return <article key={employee.employee_id} className="space-y-3 p-4 sm:p-5" data-testid={`weekly-salary-row-${employee.employee_id}`}>
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <h4 className="font-semibold text-slate-950">{employee.employee_name}</h4>
                              <Badge cls={statusClass}>{employee.payment_status}</Badge>
                              {employee.salary_rate_missing && <Badge cls="border-amber-200 bg-amber-50 text-amber-900">Rate missing</Badge>}
                            </div>
                            <p className="mt-1 text-xs text-slate-500">{employee.department || "Other"} · {key === "friday" ? weeklyPlan.friday_date : weeklyPlan.saturday_date}</p>
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <Btn
                              variant="outline" className="h-9 px-3 text-xs"
                              onClick={() => setAdvanceModal({
                                employee_id: employee.employee_id,
                                employee_name: employee.employee_name,
                                amount: "",
                                date: today(),
                                notes: "",
                              })}
                              disabled={!!savingIds[employee.employee_id]}
                            >Add balance</Btn>
                            <Btn
                              variant="outline" className="h-9 px-3 text-xs"
                              onClick={() => setCutModal({
                                employee: {
                                  ...employee,
                                  name: employee.employee_name,
                                  weekly_salary: employee.weekly_salary,
                                  gross_salary: employee.gross_salary,
                                  cut: employee.balance_cut,
                                  pay_frequency: employee.pay_frequency,
                                },
                                amount: employee.balance_cut ? String(employee.balance_cut) : "",
                                notes: "",
                              })}
                              disabled={!!savingIds[employee.employee_id] || hasPayment}
                            >Cut balance</Btn>
                            <Btn
                              variant="outline" className="h-9 px-3 text-xs"
                              onClick={() => setBalanceHistoryModal({
                                ...employee,
                                name: employee.employee_name,
                              })}
                              disabled={!!savingIds[employee.employee_id]}
                            >Balance history</Btn>
                            {!hasPayment && <Btn variant="outline" className="h-9 px-3 text-xs" onClick={() => updateWeeklyFridaySelection(employee.employee_id, key === "saturday")} disabled={weeklyPlanSaving} data-testid={`salary-assign-${key === "saturday" ? "friday" : "saturday"}-${employee.employee_id}`}>
                              {key === "saturday" ? "PAY · Friday" : "Move to Saturday"}
                            </Btn>}
                            {employee.remaining_cents > 0 && !employee.salary_rate_missing && <Btn className="h-9 px-3 text-xs" onClick={() => setWeeklyPaymentModal({
                              employee,
                              paymentDate: key === "friday" ? weeklyPlan.friday_date : weeklyPlan.saturday_date,
                              amount: String(employee.remaining_cents / 100),
                              notes: "",
                            })} disabled={!!savingIds[employee.employee_id]} data-testid={`salary-record-payment-${employee.employee_id}`}>
                              Record payment
                            </Btn>}
                          </div>
                        </div>
                        <div className="grid gap-3 rounded-xl border border-slate-200 bg-slate-50/70 p-3 sm:grid-cols-[1fr_auto]">
                          <label className="block text-xs font-semibold text-slate-600">
                            Fixed weekly salary (R)
                            <span className="mt-1 flex gap-2">
                              <input
                                type="number" min="0.01" step="0.01"
                                value={weeklySalaryDrafts[employee.employee_id] ?? ""}
                                onChange={(event) => setWeeklySalaryDrafts((current) => ({
                                  ...current, [employee.employee_id]: event.target.value,
                                }))}
                                disabled={!!savingIds[employee.employee_id] || hasPayment}
                                className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono text-sm"
                                data-testid={`salary-fixed-rate-${employee.employee_id}`}
                              />
                              <Btn
                                variant="outline" className="h-9 px-3 text-xs"
                                onClick={() => saveWeeklySalary(employee)}
                                disabled={!!savingIds[employee.employee_id] || hasPayment}
                                data-testid={`salary-fixed-rate-save-${employee.employee_id}`}
                              >Save</Btn>
                            </span>
                          </label>
                          <div className="grid grid-cols-2 gap-2 sm:min-w-[320px]">
                            <label className="block text-xs font-semibold text-slate-600">
                              Overtime hours
                              <input
                                type="number" min="0" max="168" step="0.25"
                                value={weeklyOvertimeDrafts[employee.employee_id] ?? "0"}
                                onChange={(event) => setWeeklyOvertimeDrafts((current) => ({
                                  ...current, [employee.employee_id]: event.target.value,
                                }))}
                                disabled={!!savingIds[employee.employee_id] || hasPayment}
                                className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono text-sm"
                                data-testid={`salary-overtime-hours-${employee.employee_id}`}
                              />
                            </label>
                            <label className="block text-xs font-semibold text-slate-600">
                              Overtime rate (R/hour)
                              <input
                                type="number" min="0" step="0.01"
                                value={weeklyOvertimeRateDrafts[employee.employee_id] ?? "21"}
                                onChange={(event) => setWeeklyOvertimeRateDrafts((current) => ({
                                  ...current, [employee.employee_id]: event.target.value,
                                }))}
                                disabled={!!savingIds[employee.employee_id] || hasPayment}
                                className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono text-sm"
                                data-testid={`salary-overtime-rate-${employee.employee_id}`}
                              />
                            </label>
                            <Btn
                              className="col-span-2 h-9 px-3 text-xs"
                              onClick={() => saveWeeklyOvertime(employee)}
                              disabled={!!savingIds[employee.employee_id] || hasPayment}
                              data-testid={`salary-overtime-save-${employee.employee_id}`}
                            >Save overtime</Btn>
                          </div>
                          {hasPayment && <p className="text-[11px] text-slate-500 sm:col-span-2">Payroll is locked after the first payment; saved salary and overtime values remain unchanged.</p>}
                        </div>
                        <div className="grid grid-cols-2 gap-3 border-y border-slate-100 py-3 sm:grid-cols-3">
                          <div><p className="text-[10px] font-semibold uppercase text-slate-500">Balance</p><p className="mt-1 font-mono font-semibold">{fmtMoney(Number(employee.balance_before_period || 0))}</p></div>
                          <div><p className="text-[10px] font-semibold uppercase text-slate-500">Balance cut</p><p className="mt-1 font-mono font-semibold text-red-600">−{fmtMoney(Number(employee.balance_cut || 0))}</p></div>
                          <div><p className="text-[10px] font-semibold uppercase text-slate-500">Balance after cut</p><p className="mt-1 font-mono font-semibold">{fmtMoney(Number(employee.balance_after_period || 0))}</p></div>
                          <div><p className="text-[10px] font-semibold uppercase text-slate-500">Gross salary</p><p className="mt-1 font-mono font-semibold">{fmtMoney(Number(employee.gross_salary || 0))}</p></div>
                          <div className="rounded-lg bg-red-50 p-2"><p className="text-[10px] font-semibold uppercase text-red-700">Salary after balance cut</p><p className="mt-1 font-mono font-bold text-red-700">{fmtMoney(employee.due_cents / 100)}</p></div>
                          <div className="rounded-lg bg-lime-950 p-2 ring-1 ring-lime-400/50 shadow-[0_0_16px_rgba(163,230,53,0.2)]"><p className="text-[10px] font-bold uppercase text-lime-300">Take-home salary</p><p className="mt-1 font-mono text-lg font-extrabold text-lime-300">{fmtMoney(employee.remaining_cents / 100)}</p></div>
                          <div><p className="text-[10px] font-semibold uppercase text-slate-500">Actually paid</p><p className="mt-1 font-mono font-semibold">{fmtMoney(employee.paid_cents / 100)}</p></div>
                          <div><p className="text-[10px] font-semibold uppercase text-slate-500">Outstanding</p><p className="mt-1 font-mono font-semibold">{fmtMoney(employee.remaining_cents / 100)}</p></div>
                          <div><p className="text-[10px] font-semibold uppercase text-slate-500">Payment date</p><p className="mt-1 text-sm font-medium">{paymentsForEmployee.length ? paymentsForEmployee.map((payment) => payment.payment_date).join(", ") : "Not paid"}</p></div>
                        </div>
                        {paymentsForEmployee.length > 0 && <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-500" aria-label={`Payment history for ${employee.employee_name}`}>
                          {paymentsForEmployee.map((payment) => <span key={payment.id}>{payment.payment_date}: {fmtMoney(Number(payment.amount_cents || 0) / 100)}{payment.legacy ? " · legacy payment" : ""}</span>)}
                        </div>}
                      </article>;
                    })}
                  </div>}
              </Card>;
            })}
          </div> : <div className="rounded-2xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-500" role="status">Loading Friday and Saturday groups…</div>}
        </section> : <section className="hidden space-y-4" aria-label="Employee payroll">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h3 className="font-display text-xl font-semibold text-slate-950">Employee payroll</h3>
              <p className="mt-1 text-xs text-slate-500">
                {periodType === "weekly"
                  ? `${displayDate(period?.start)} – ${displayDate(period?.end)}`
                  : displayMonth(monthValue)}
                {report ? ` · ${report.employees.length} employees` : ""}
              </p>
            </div>
            <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
              <div className="relative min-w-0 flex-1 sm:w-64 sm:flex-none">
                <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search employee"
                  aria-label="Search employee"
                  className="h-11 w-full rounded-xl border border-slate-200 bg-white pl-10 pr-3 text-sm text-slate-800 outline-none transition focus:border-[#9fcfba] focus:ring-4 focus:ring-[#e7f6ef]"
                  data-testid="salary-search"
                />
              </div>
              <div className="relative">
                <button type="button" onClick={() => setFiltersOpen((current) => !current)} aria-expanded={filtersOpen} className={"inline-flex h-11 items-center gap-2 rounded-xl border px-4 text-sm font-semibold transition-colors " + (department ? "border-[#b8ddca] bg-[#eff9f4] text-[#34725c]" : "border-slate-200 bg-white text-slate-700 hover:bg-slate-50")} data-testid="salary-filter-toggle">
                  <SlidersHorizontal size={16} /> Filters{department ? " · 1" : ""}
                </button>
                {filtersOpen && <div className="absolute right-0 top-12 z-20 w-64 rounded-2xl border border-slate-200 bg-white p-4 shadow-xl">
                  <Select label="Department" value={department} onChange={(event) => setDepartment(event.target.value)} data-testid="salary-department">
                    <option value="">All departments</option>
                    {departments.map((item) => <option key={item} value={item}>{item}</option>)}
                  </Select>
                  {department && <button type="button" onClick={() => setDepartment("")} className="mt-3 text-xs font-semibold text-[#34725c] hover:underline">Clear filter</button>}
                </div>}
              </div>
            </div>
          </div>

          {loading
            ? <div className="rounded-2xl border border-slate-200 bg-white p-12 text-center text-sm text-slate-500">Calculating payroll from saved records…</div>
            : !report ? <Card className="rounded-2xl"><Empty icon={Wallet} title="Choose a valid pay period" hint="Select a week or complete calendar month." /></Card>
              : filteredRows.length === 0 ? <Card className="rounded-2xl"><Empty icon={Search} title="No employees match your search" /></Card>
                : <div className="grid gap-3">
                  {filteredRows.map((row) => {
                    const employee = row.employee;
                    return <PayrollEmployeeCard
                      key={employee.employee_id}
                      row={row}
                      periodType={periodType}
                      expanded={!!expanded[employee.employee_id]}
                      onToggleExpanded={(forceOpen = false) => setExpanded((current) => ({
                        ...current,
                        [employee.employee_id]: forceOpen ? true : !current[employee.employee_id],
                      }))}
                      onIncludeChange={(included) => setMonthlyIncluded((current) => ({ ...current, [employee.employee_id]: included }))}
                      rateValue={row.payment?.calculation_snapshot
                        ? String(row.monthly ? (employee.monthly_salary ?? "") : (employee.weekly_salary ?? ""))
                        : rateDrafts[employee.employee_id] ?? ""}
                      onRateChange={(value) => setRateDrafts((current) => ({ ...current, [employee.employee_id]: value }))}
                      configuration={row.payment?.calculation_snapshot
                        ? payrollConfigFromEmployee(employee)
                        : configurationDrafts[employee.employee_id] || payrollConfigFromEmployee(employee)}
                      onConfigurationChange={(field, value) => {
                        setConfigurationDrafts((current) => ({
                          ...current,
                          [employee.employee_id]: {
                            ...(current[employee.employee_id] || payrollConfigFromEmployee(employee)),
                            [field]: value,
                          },
                        }));
                        if (field === "pay_mode") {
                          const nextRate = value === "monthly"
                            ? employee.monthly_salary ?? ""
                            : employee.weekly_salary ?? "";
                          setRateDrafts((current) => ({ ...current, [employee.employee_id]: String(nextRate) }));
                        }
                      }}
                      paymentDate={paymentDates[employee.employee_id] || today()}
                      onPaymentDateChange={(value) => setPaymentDates((current) => ({ ...current, [employee.employee_id]: value }))}
                      saving={!!savingIds[employee.employee_id]}
                      onSaveRate={() => saveRate(employee)}
                      onAddAdvance={() => setAdvanceModal({ employee_id: employee.employee_id, employee_name: employee.name, amount: "", date: today(), notes: "" })}
                      onCutBalance={() => setCutModal({
                        employee,
                        amount: "",
                        notes: "",
                      })}
                      onShowBalanceHistory={() => setBalanceHistoryModal(employee)}
                      onMarkPaid={() => markPaid(row)}
                    />;
                  })}
                </div>}
          <div className="flex flex-wrap items-center justify-between gap-2 px-1 text-xs text-slate-500">
            <span>{reportRows.length} employees included · {includedPaidRows.length} settled</span>
            <span>Attendance and cuts update current payroll; recorded payments stay unchanged.</span>
          </div>
        </section>}

      </> : view === "ribbon" ? <section className="space-y-4" data-testid="ribbon-piecework-section">
        <Card className="p-5">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#39806b]">Ayanda &amp; Asive</p>
              <h3 className="mt-1 text-xl font-semibold text-slate-950">RIBBON MATTRESS – PIECEWORK</h3>
              <p className="mt-1 text-xs text-slate-500">Monday–Friday target 70 · Saturday target 40 · Sunday excluded</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {[["day", "Day"], ["week", "Week"], ["month", "Month"], ["custom", "Custom"]].map(([mode, label]) => <Btn
                key={mode}
                variant={ribbonReportMode === mode ? "primary" : "outline"}
                className="h-9 px-3 text-xs"
                onClick={() => setRibbonReportMode(mode)}
              >{label}</Btn>)}
            </div>
          </div>
          <div className="mt-4 flex flex-wrap items-end gap-3">
            {ribbonReportMode === "day" || ribbonReportMode === "week" || ribbonReportMode === "month"
              ? <Input label={ribbonReportMode === "month" ? "Report month" : "Report date"}
                  type={ribbonReportMode === "month" ? "month" : "date"}
                  value={ribbonReportMode === "month" ? ribbonDate.slice(0, 7) : ribbonDate}
                  onChange={(event) => setRibbonDate(ribbonReportMode === "month" ? event.target.value + "-01" : event.target.value)} />
              : <>
                  <Input label="Start date" type="date" value={ribbonCustomStart} onChange={(event) => setRibbonCustomStart(event.target.value)} />
                  <Input label="End date" type="date" value={ribbonCustomEnd} onChange={(event) => setRibbonCustomEnd(event.target.value)} />
                </>}
          </div>
          {ribbonPeriod && <p className="mt-3 text-xs font-medium text-slate-500">Report period: {ribbonPeriod.start} – {ribbonPeriod.end}</p>}
        </Card>

        <Card className="p-5">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h4 className="font-semibold text-slate-950">Daily production</h4>
              <p className="mt-1 text-xs text-slate-500">Enter whole pieces for Monday–Saturday.</p>
            </div>
            <Input label="Production date" type="date" value={ribbonDate}
              onChange={(event) => setRibbonDate(event.target.value)} className="w-44" />
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {(ribbonReport?.employees || []).filter(isPieceworkTailor).map((employee) => {
              const existing = (employee.piece_days || []).find((day) => day.date === ribbonDate)?.pieces
                ?? (ribbonReport?.piece_days || []).find((day) => day.employee_id === employee.employee_id && day.date === ribbonDate)?.pieces;
              const sunday = ribbonDate && new Date(ribbonDate + "T00:00:00Z").getUTCDay() === 0;
              return <div key={employee.employee_id} className="flex items-end gap-3 rounded-xl border border-slate-200 p-3">
                <div className="flex-1">
                  <p className="text-sm font-semibold text-slate-950">{employee.name}</p>
                  <p className="mt-1 text-xs text-slate-500">Saved: {existing ?? 0} pieces</p>
                </div>
                <div className="w-28">
                  <Input label="Pieces" type="number" min="0" step="1"
                    value={ribbonDrafts[employee.employee_id] ?? String(existing ?? "")}
                    onChange={(event) => setRibbonDrafts((current) => ({ ...current, [employee.employee_id]: event.target.value }))}
                    disabled={!!ribbonSaving[employee.employee_id] || sunday} />
                </div>
                <Btn onClick={() => saveRibbonProduction(employee, ribbonDate, ribbonDrafts[employee.employee_id] ?? existing ?? 0)}
                  disabled={!!ribbonSaving[employee.employee_id] || sunday} data-testid={`ribbon-save-${employee.employee_id}`}>
                  {ribbonSaving[employee.employee_id] ? "Saving…" : "Save"}
                </Btn>
              </div>;
            })}
          </div>
        </Card>

        <Card className="overflow-hidden">
          <div className="border-b border-border p-4">
            <h4 className="font-semibold text-slate-950">Piecework report</h4>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse text-sm">
              <thead className="bg-slate-50 text-left text-[10px] uppercase text-slate-500">
                <tr><th className="px-4 py-3">Employee</th><th className="px-4 py-3">Pieces</th><th className="px-4 py-3">Earnings</th><th className="px-4 py-3">Targets achieved</th><th className="px-4 py-3">Targets missed</th><th className="px-4 py-3">Average / day</th></tr>
              </thead>
              <tbody>
                {(ribbonReport?.employees || []).filter(isPieceworkTailor).map((employee) => {
                  const days = (employee.piece_days || []).filter((day) => day.recorded !== false);
                  const achieved = days.filter((day) => day.recorded && day.pieces >= day.target).length;
                  const missed = days.filter((day) => day.recorded && day.pieces < day.target).length;
                  const average = days.length ? Number(employee.total_pieces || 0) / days.length : 0;
                  return <tr key={employee.employee_id} className="border-t border-slate-100">
                    <td className="px-4 py-3 font-semibold">{employee.name}</td>
                    <td className="px-4 py-3 font-mono">{employee.total_pieces || 0}</td>
                    <td className="px-4 py-3 font-mono">{fmtMoney(employee.piece_pay || 0)}</td>
                    <td className="px-4 py-3">{achieved}</td>
                    <td className="px-4 py-3">{missed}</td>
                    <td className="px-4 py-3 font-mono">{average.toFixed(2)}</td>
                  </tr>;
                })}
                {(ribbonReport?.employees || []).filter(isPieceworkTailor).length > 0 && (() => {
                  const ribbonEmployees = (ribbonReport?.employees || []).filter(isPieceworkTailor);
                  const allDays = ribbonEmployees.flatMap((employee) => (employee.piece_days || []).filter((day) => day.recorded));
                  const combinedPieces = ribbonEmployees.reduce((sum, employee) => sum + Number(employee.total_pieces || 0), 0);
                  const combinedPay = ribbonEmployees.reduce((sum, employee) => sum + cents(employee.piece_pay || 0), 0);
                  const combinedAchieved = allDays.filter((day) => day.pieces >= day.target).length;
                  const combinedMissed = allDays.filter((day) => day.pieces < day.target).length;
                  const combinedAverage = allDays.length ? combinedPieces / allDays.length : 0;
                  return <tr className="border-t-2 border-slate-300 bg-slate-50 font-semibold">
                    <td className="px-4 py-3">Combined total</td>
                    <td className="px-4 py-3 font-mono">{combinedPieces}</td>
                    <td className="px-4 py-3 font-mono">{fmtMoney(combinedPay / 100)}</td>
                    <td className="px-4 py-3">{combinedAchieved}</td>
                    <td className="px-4 py-3">{combinedMissed}</td>
                    <td className="px-4 py-3 font-mono">{combinedAverage.toFixed(2)}</td>
                  </tr>;
                })()}
              </tbody>
            </table>
          </div>
        </Card>
      </section> : <Card className="overflow-hidden">
        <div className="border-b border-border p-4">
          <h3 className="font-display text-lg font-semibold text-foreground">Payment history</h3>
          <p className="mt-1 text-xs text-muted-foreground">Recorded payments are read-only and remain separate from new borrowed balances.</p>
        </div>
        {historyLoading ? <div className="p-10 text-center text-sm text-muted-foreground">Loading payment history…</div>
          : history.length === 0 ? <Empty icon={History} title="No salary payments recorded yet" hint="Mark a payroll as paid to create the first payment record." />
          : <div className="grid gap-3 p-4 sm:grid-cols-2">
            {history.map((payment) => <article key={payment.id} className="rounded-2xl border border-slate-200 bg-white p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-semibold text-slate-950">{payment.employee_name}</p>
                  <p className="mt-1 text-xs text-slate-500">{payment.period_type === "monthly" ? "Month " + payment.period_start.slice(0, 7) : payment.period_start + " – " + payment.period_end}</p>
                </div>
                <Badge cls="border-emerald-200 bg-emerald-50 text-emerald-800">Paid</Badge>
              </div>
              <div className="mt-4 grid grid-cols-3 gap-2 border-t border-slate-100 pt-3 text-xs">
                <div><p className="text-slate-500">Gross</p><p className="mt-1 font-mono font-semibold">{fmtMoney(payment.gross_amount)}</p></div>
                <div><p className="text-slate-500">Deduction</p><p className="mt-1 font-mono font-semibold">{fmtMoney(payment.deduction_amount)}</p></div>
                <div><p className="text-slate-500">Net paid</p><p className="mt-1 font-mono font-semibold">{fmtMoney(payment.net_amount)}</p></div>
              </div>
              <p className="mt-3 text-[11px] text-slate-500">Paid {payment.payment_date}</p>
            </article>)}
          </div>}
      </Card>}

      <Modal open={currentBalancesOpen} onClose={() => setCurrentBalancesOpen(false)} title="All employees — Current balances">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
            <span>{currentBalances?.length || 0} employees</span>
            <span>Last refreshed: {currentBalancesRefreshedAt || "—"}</span>
          </div>
          <div className="max-h-[60vh] overflow-y-auto rounded-xl border border-slate-200">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-slate-50 text-left text-[11px] uppercase tracking-wide text-slate-500">
                <tr><th className="px-3 py-2">Employee</th><th className="px-3 py-2">Department</th><th className="px-3 py-2 text-right">Total current balance</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {(currentBalances || []).map((employee) => (
                  <tr key={employee.employee_id}>
                    <td className="px-3 py-2 font-medium text-slate-800">{employee.name || "Unnamed"}</td>
                    <td className="px-3 py-2 text-slate-500">{salaryDepartment(employee)}</td>
                    <td className="px-3 py-2 text-right font-mono font-semibold tabular-nums">{fmtMoney(employee.balance || 0)}</td>
                  </tr>
                ))}
                {!currentBalances?.length && <tr><td colSpan={3} className="px-3 py-6 text-center text-slate-500">No employee balances available.</td></tr>}
              </tbody>
              <tfoot className="sticky bottom-0 border-t border-slate-200 bg-slate-50">
                <tr><td colSpan={2} className="px-3 py-2 font-semibold text-slate-700">Combined total</td><td className="px-3 py-2 text-right font-mono font-bold">{fmtMoney((currentBalances || []).reduce((sum, employee) => sum + Number(employee.balance || 0), 0))}</td></tr>
              </tfoot>
            </table>
          </div>
          <div className="flex justify-end">
            <Btn variant="outline" onClick={() => setCurrentBalancesOpen(false)}>Close</Btn>
          </div>
        </div>
      </Modal>
      <Modal open={!!advanceModal} onClose={() => setAdvanceModal(null)} title={"Add borrowed balance — " + (advanceModal?.employee_name || "")}>
        {advanceModal && <div className="space-y-4">
          <Input label="Amount borrowed (R)" type="number" min="0.01" step="0.01" value={advanceModal.amount} onChange={(event) => setAdvanceModal({ ...advanceModal, amount: event.target.value })} data-testid="salary-advance-amount" />
          <Input label="Date" type="date" value={advanceModal.date} onChange={(event) => setAdvanceModal({ ...advanceModal, date: event.target.value })} />
          <Input label="Notes" value={advanceModal.notes} onChange={(event) => setAdvanceModal({ ...advanceModal, notes: event.target.value })} />
          <div className="flex justify-end gap-2">
            <Btn variant="outline" onClick={() => setAdvanceModal(null)}>Cancel</Btn>
            <Btn onClick={saveAdvance}>Save borrowed balance</Btn>
          </div>
        </div>}
      </Modal>
      <Modal open={!!weeklyPaymentModal} onClose={() => !savingIds[weeklyPaymentModal?.employee?.employee_id] && setWeeklyPaymentModal(null)} title={"Record salary payment — " + (weeklyPaymentModal?.employee?.employee_name || "")}>
        {weeklyPaymentModal && <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 rounded-xl bg-slate-50 p-4 text-sm">
            <div><p className="text-xs text-slate-500">Salary due</p><p className="mt-1 font-mono font-semibold">{fmtMoney(weeklyPaymentModal.employee.due_cents / 100)}</p></div>
            <div><p className="text-xs text-slate-500">Outstanding before payment</p><p className="mt-1 font-mono font-semibold">{fmtMoney(weeklyPaymentModal.employee.remaining_cents / 100)}</p></div>
          </div>
          <Input label="Amount actually paid (R)" type="number" min="0.01" max={weeklyPaymentModal.employee.remaining_cents / 100} step="0.01" value={weeklyPaymentModal.amount}
            onChange={(event) => setWeeklyPaymentModal((current) => ({ ...current, amount: event.target.value }))} data-testid="weekly-salary-payment-amount" />
          <Input label="Actual payment date" type="date" min={weeklyPlan?.friday_date} max={weeklyPlan?.saturday_date} value={weeklyPaymentModal.paymentDate}
            onChange={(event) => setWeeklyPaymentModal((current) => ({ ...current, paymentDate: event.target.value }))} data-testid="weekly-salary-payment-date" />
          <Input label="Notes (optional)" value={weeklyPaymentModal.notes}
            onChange={(event) => setWeeklyPaymentModal((current) => ({ ...current, notes: event.target.value }))} data-testid="weekly-salary-payment-notes" />
          <div className="flex justify-end gap-2">
            <Btn variant="outline" onClick={() => setWeeklyPaymentModal(null)} disabled={!!savingIds[weeklyPaymentModal.employee.employee_id]}>Cancel</Btn>
            <Btn onClick={recordWeeklySalaryPayment} disabled={!!savingIds[weeklyPaymentModal.employee.employee_id]} data-testid="weekly-salary-payment-confirm">
              {savingIds[weeklyPaymentModal.employee.employee_id] ? "Recording..." : "Confirm payment"}
            </Btn>
          </div>
        </div>}
      </Modal>
      <Modal open={!!cutModal} onClose={() => setCutModal(null)} title={"Cut balance — " + (cutModal?.employee?.name || "")}>
        {cutModal && <div className="space-y-4">
          <p className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
            Payroll period: {period?.start} – {period?.end}. This cut will be recorded against this period.
          </p>
          <Input
            label="Amount to cut (R)"
            type="number"
            min="0.01"
            step="0.01"
            max={Number(cutModal.employee.gross_salary || 0)}
            value={cutModal.amount}
            onChange={(event) => setCutModal({ ...cutModal, amount: event.target.value })}
            data-testid="salary-cut-amount"
          />
          <Input
            label="Notes"
            value={cutModal.notes}
            onChange={(event) => setCutModal({ ...cutModal, notes: event.target.value })}
            data-testid="salary-cut-notes"
          />
          <div className="flex justify-end gap-2">
            <Btn variant="outline" onClick={() => setCutModal(null)}>Cancel</Btn>
            <Btn
              onClick={() => saveCut(cutModal.employee, cutModal)}
              disabled={!!savingIds[cutModal.employee.employee_id]}
              data-testid="salary-cut-save"
            >Save cut</Btn>
          </div>
        </div>}
      </Modal>
      <Modal
        open={!!balanceHistoryModal}
        onClose={() => setBalanceHistoryModal(null)}
        title={"Balance cut/add history — " + (balanceHistoryModal?.name || "")}
      >
        {balanceHistoryModal && <div className="space-y-4">
          <div className="rounded-xl bg-slate-50 p-4">
            <p className="text-xs font-medium text-slate-500">Current balance due</p>
            <p className="mt-1 font-mono text-lg font-semibold text-slate-950">{fmtMoney(balanceHistoryModal.balance || 0)}</p>
          </div>
          {balanceHistoryModal.balance_history?.length ? (
            <ol className="max-h-[55vh] space-y-3 overflow-y-auto">
              {[...balanceHistoryModal.balance_history].reverse().map((entry) => (
                <li key={entry.type + "-" + entry.id} className="flex items-start justify-between gap-4 rounded-xl border border-slate-200 p-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-900">
                      {entry.type === "advance" ? "Borrowed amount added" : "Balance cut"}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      {entry.type === "advance" ? "Taken" : "Cut"} on {entry.date || "Date unavailable"}
                    </p>
                    {entry.notes && <p className="mt-1 break-words text-xs text-slate-600">{entry.notes}</p>}
                  </div>
                  <strong className={"shrink-0 font-mono " + (entry.type === "advance" ? "text-amber-700" : "text-emerald-700")}>
                    {entry.type === "advance" ? "+" : "−"}{fmtMoney(entry.amount)}
                  </strong>
                </li>
              ))}
            </ol>
          ) : <p className="rounded-xl border border-slate-200 p-4 text-sm text-slate-500">No balance additions or cuts recorded yet.</p>}
          <div className="flex flex-wrap justify-between gap-2">
            <Btn
              variant="outline"
              className="border-red-200 text-red-700 hover:bg-red-50"
              onClick={clearBalanceHistory}
              disabled={!balanceHistoryModal.balance_history?.length || !!savingIds[balanceHistoryModal.employee_id]}
              data-testid="salary-clear-balance-history"
            ><Trash2 size={14} /> Delete all history</Btn>
            <Btn variant="outline" onClick={() => setBalanceHistoryModal(null)}>Close</Btn>
          </div>
        </div>}
      </Modal>
    </div>
  );
}
