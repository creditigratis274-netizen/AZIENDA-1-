export function updateGrvReceivedQuantity(line, value) {
  const previousReceived = Number(line.actual_received_quantity) || 0;
  const accepted = Number(line.accepted_quantity) || 0;
  const received = Number(value) || 0;

  return {
    ...line,
    actual_received_quantity: received,
    ...(accepted === previousReceived ? { accepted_quantity: received } : {}),
  };
}

export function parseGrvDecimal(value) {
  if (typeof value === "number") return value;
  const text = String(value ?? "").trim().replace(/\s/g, "");
  if (!text) return 0;
  const normalized = text.includes(",") && text.includes(".")
    ? text.replace(/\./g, "").replace(",", ".")
    : text.replace(",", ".");
  return Number(normalized);
}

export function grvLineCalculations(line = {}) {
  const containerCount = Number(line.container_count ?? line.accepted_quantity ?? 0) || 0;
  const containerCapacity = Number(line.container_capacity ?? line.size ?? 0) || 0;
  const unitPrice = parseGrvDecimal(line.unit_cost);
  const priceBasis = line.price_basis
    || (containerCapacity > 0 && /^(kg|kgs|kilograms?|l|liters?|litres?)$/i.test(String(line.unit || "").trim())
      ? "per_unit" : "per_container");
  const totalQuantity = priceBasis === "per_unit"
    ? containerCount * containerCapacity
    : containerCount;
  const subtotal = totalQuantity * (Number.isFinite(unitPrice) ? unitPrice : 0);
  return {
    containerCount,
    containerCapacity,
    totalQuantity,
    priceBasis,
    subtotal,
  };
}

export function grvTotals(items = [], vatRate = 0, freightCost = 0) {
  const subtotal = items.reduce((sum, line) => sum + grvLineCalculations(line).subtotal, 0);
  const rate = parseGrvDecimal(vatRate);
  const freight = parseGrvDecimal(freightCost);
  const freightAmount = Number.isFinite(freight) ? Math.max(0, freight) : 0;
  const taxableSubtotal = subtotal + freightAmount;
  const vatAmount = taxableSubtotal * (Number.isFinite(rate) ? rate : 0) / 100;
  return {
    subtotal,
    taxableSubtotal,
    vatAmount,
    freightAmount,
    total: taxableSubtotal + vatAmount,
  };
}
