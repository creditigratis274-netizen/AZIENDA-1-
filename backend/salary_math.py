from datetime import date, datetime
from decimal import Decimal, ROUND_HALF_UP

STANDARD_WEEKLY_HOURS = 45
STANDARD_PAID_DAYS_PER_WEEK = 6
WEEKDAY_REGULAR_HOURS = 8
SATURDAY_REGULAR_HOURS = 6
OVERTIME_HOURLY_RATE = 21
OVERTIME_AFTER_17_HOURLY_RATE = 21


def calculate_salary_hours(records, half_day_hours=4):
    days = []

    for record in sorted(records, key=lambda item: item.get("date", "")):
        status = record.get("status")
        start_time = record.get("start_time")
        end_time = record.get("end_time")
        overtime_after_17 = 0.0

        if status not in ("Present", "Half Day"):
            worked_hours = 0.0
            manual_overtime = 0.0
        elif start_time and end_time:
            start = datetime.strptime(start_time, "%H:%M")
            end = datetime.strptime(end_time, "%H:%M")
            elapsed_hours = ((end - start).total_seconds() / 3600) % 24
            weekday = date.fromisoformat(record["date"]).weekday()
            worked_hours = (
                max(0, elapsed_hours - 1)
                if weekday < 5 and elapsed_hours > WEEKDAY_REGULAR_HOURS
                else elapsed_hours
            )
            end_minutes = end.hour * 60 + end.minute
            overtime_after_17 = max(0, (end_minutes - 17 * 60) / 60)
            manual_overtime = max(0.0, float(record.get("overtime_hours") or 0))
        else:
            weekday = date.fromisoformat(record["date"]).weekday()
            default_full_day = SATURDAY_REGULAR_HOURS if weekday == 5 else WEEKDAY_REGULAR_HOURS if weekday < 5 else 0
            worked_hours = default_full_day if status == "Present" else float(half_day_hours) if status == "Half Day" else 0
            manual_overtime = max(0.0, float(record.get("overtime_hours") or 0))
            overtime_after_17 = 0.0

        weekday = date.fromisoformat(record["date"]).weekday()
        scheduled_hours = SATURDAY_REGULAR_HOURS if weekday == 5 else WEEKDAY_REGULAR_HOURS if weekday < 5 else 0
        worked_hours = max(0, worked_hours)
        overtime = manual_overtime if manual_overtime > 0 else overtime_after_17
        regular = max(0, worked_hours - overtime)
        attendance_fraction = 1 if status == "Present" else 0.5 if status == "Half Day" else 0
        if scheduled_hours:
            attendance_fraction = min(attendance_fraction, min(regular, scheduled_hours) / scheduled_hours)
        else:
            attendance_fraction = 0
        days.append({
            "date": record.get("date"),
            "status": status,
            "worked_hours": worked_hours,
            "regular_hours": regular,
            "overtime_hours": overtime,
            "overtime_after_17_hours": min(overtime, overtime_after_17),
            "attendance_fraction": attendance_fraction,
            "salary_overtime_override": record.get("salary_overtime_override"),
            "salary_overtime_rate_override": record.get("salary_overtime_rate_override"),
        })

    return days


def calculate_salary_rule(weekly_salary, worked_hours, overtime_amount=0, divisor=48):
    weekly_salary = Decimal(str(weekly_salary or 0))
    worked_hours = Decimal(str(worked_hours or 0))
    divisor = Decimal(str(divisor or 48))
    overtime_amount = Decimal(str(overtime_amount or 0))
    regular_pay = (
        weekly_salary
        if worked_hours >= divisor
        else weekly_salary * worked_hours / divisor
    ).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    return {
        "regular_pay": float(regular_pay),
        "overtime_pay": float(overtime_amount),
        "gross_pay": float((regular_pay + overtime_amount).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)),
    }


def calculate_piecework_formula(quantities, formula, overtime_amount=0):
    quantities = [int(quantity or 0) for quantity in quantities]
    profile_index = max(0, min(13, ord(str(formula or "A").upper()) - ord("A")))
    low_rate = Decimal("2.50")
    high_rate = Decimal("3.50")
    threshold = 70 - profile_index
    total_pieces = sum(quantities)
    high_pieces = max(0, total_pieces - threshold)
    low_pieces = total_pieces - high_pieces
    piece_pay = low_pieces * low_rate + high_pieces * high_rate
    overtime_amount = Decimal(str(overtime_amount or 0))
    gross = piece_pay + overtime_amount
    return {
        "piece_pay": float(piece_pay.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)),
        "overtime_amount": float(overtime_amount),
        "gross": float(gross.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)),
    }


def calculate_net_and_balance(gross, cut=0, opening_balance=0):
    gross = Decimal(str(gross or 0))
    cut = Decimal(str(cut or 0))
    opening_balance = Decimal(str(opening_balance or 0))
    net_pay = max(Decimal("0"), gross - cut)
    remaining_balance = max(Decimal("0"), opening_balance - cut)
    return {
        "net_pay": float(net_pay.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)),
        "remaining_balance": float(remaining_balance.quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)),
    }
