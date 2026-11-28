import math
from decimal import Decimal, ROUND_HALF_UP


def grv_line_total_quantity(line, accepted=None):
    accepted_quantity = float(line.get("accepted_quantity", 0) if accepted is None else accepted)
    container_count = float(line.get("container_count") or accepted_quantity)
    container_capacity = float(line.get("container_capacity") or 0)
    unit = str(line.get("unit") or "").strip().casefold()
    price_basis = line.get("price_basis")
    # KGR is the ERP's explicit per-kilogram unit, including legacy records
    # that were incorrectly saved with price_basis="per_container".
    if unit == "kgr" and container_capacity > 0:
        return container_count * container_capacity
    if price_basis == "per_unit":
        return container_count * container_capacity
    if price_basis == "per_container":
        return container_count
    return accepted_quantity


def grv_line_total_value(line):
    container_count = Decimal(str(float(line.get("container_count") or line.get("accepted_quantity", 0))))
    container_capacity = Decimal(str(float(line.get("container_capacity") or 0)))
    unit_cost = Decimal(str(float(line.get("unit_cost", 0))))
    unit = str(line.get("unit") or "").strip().casefold()
    price_basis = line.get("price_basis")
    if unit == "kgr" and container_capacity > 0:
        quantity = container_count * container_capacity
        return (quantity * unit_cost).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    if price_basis == "per_unit" and container_capacity > 0:
        quantity = container_count * container_capacity
        return (quantity * unit_cost).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    if price_basis == "per_container":
        return (container_count * unit_cost).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    fallback = line.get("total_value")
    if fallback is not None:
        return Decimal(str(fallback)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    return (Decimal(str(float(line.get("accepted_quantity", 0)))) * unit_cost).quantize(
        Decimal("0.01"), rounding=ROUND_HALF_UP,
    )


def validate_grv_line_quantities(line, *, remaining=None):
    actual = float(line.get("actual_received_quantity", 0))
    accepted = float(line.get("accepted_quantity", 0))
    rejected = float(line.get("rejected_quantity", 0))
    damaged = float(line.get("damaged_quantity", 0))
    unit_cost = float(line.get("unit_cost", 0))
    values = (actual, accepted, rejected, damaged, unit_cost)
    if any(not math.isfinite(value) or value < 0 for value in values):
        raise ValueError("GRV quantities and unit cost must be finite and non-negative")
    actual_decimal = Decimal(str(actual))
    accepted_decimal = Decimal(str(accepted))
    rejected_decimal = Decimal(str(rejected))
    damaged_decimal = Decimal(str(damaged))
    unit_cost_decimal = Decimal(str(unit_cost))
    # Goods with no rejection recorded are accepted, otherwise they would never reach stock.
    if accepted_decimal == 0 and rejected_decimal == 0 and actual_decimal > 0:
        accepted = float(actual_decimal)
        accepted_decimal = actual_decimal
    if accepted_decimal + rejected_decimal > actual_decimal:
        raise ValueError("Accepted and rejected quantities cannot exceed actual received quantity")
    if damaged_decimal > rejected_decimal:
        raise ValueError("Damaged quantity cannot exceed rejected quantity")
    if remaining is not None and actual_decimal > Decimal(str(remaining)):
        raise ValueError(f"Actual received quantity cannot exceed the remaining quantity ({remaining:g})")
    container_count = float(line.get("container_count") or accepted)
    container_capacity = float(line.get("container_capacity") or 0)
    price_basis = line.get("price_basis")
    total_quantity = grv_line_total_quantity({
        **line,
        "accepted_quantity": accepted,
        "container_count": container_count,
        "container_capacity": container_capacity,
    }, accepted=accepted)
    total_quantity_decimal = Decimal(str(total_quantity if math.isfinite(total_quantity) else 0))
    total_value = (total_quantity_decimal * unit_cost_decimal).quantize(
        Decimal("0.01"), rounding=ROUND_HALF_UP,
    )
    return {
        "actual_received_quantity": actual,
        "accepted_quantity": accepted,
        "rejected_quantity": rejected,
        "damaged_quantity": damaged,
        "unit_cost": unit_cost,
        "container_count": container_count,
        "container_capacity": container_capacity,
        "total_quantity": float(total_quantity_decimal),
        "price_basis": price_basis,
        "total_value": float(total_value),
    }


def aggregate_accepted_stock_lines(lines):
    grouped = {}
    for line in lines:
        quantity = float(line.get("accepted_quantity", 0))
        if quantity <= 0:
            continue
        stock_id = line["stock_id"]
        row = grouped.setdefault(stock_id, {
            "stock_id": stock_id,
            "product": line["product"],
            "size": line.get("size", ""),
            "quantity": 0.0,
            "total_value": 0.0,
        })
        row["quantity"] = round(row["quantity"] + quantity, 4)
        line_value = Decimal(str(line.get("total_value", quantity * float(line.get("unit_cost", 0))))).quantize(
            Decimal("0.01"), rounding=ROUND_HALF_UP,
        )
        row["total_value"] = float(
            (Decimal(str(row["total_value"])) + line_value).quantize(
                 Decimal("0.01"), rounding=ROUND_HALF_UP,
             )
        )
    for row in grouped.values():
        row["unit_cost"] = (
            float(
                (Decimal(str(row["total_value"])) / Decimal(str(row["quantity"]))).quantize(
                    Decimal("0.0001"), rounding=ROUND_HALF_UP,
                )
            ) if row["quantity"] else 0
        )
    return list(grouped.values())


def grv_confirmation_status(lines, purchase_order_complete):
    has_discrepancy = any(
        line.get("rejected_quantity", 0) > 0
        or line.get("damaged_quantity", 0) > 0
        for line in lines
    )
    if has_discrepancy:
        return "discrepancy"
    return "completed" if purchase_order_complete else "partially_received"
