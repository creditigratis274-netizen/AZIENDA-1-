import test from "node:test";
import assert from "node:assert/strict";
import { grvLineCalculations, grvTotals, parseGrvDecimal, updateGrvReceivedQuantity } from "./grv.mjs";

test("accepted GRV quantity follows received quantity until changed manually", () => {
  const initial = {
    actual_received_quantity: 0,
    accepted_quantity: 0,
  };

  assert.deepEqual(updateGrvReceivedQuantity(initial, 10), {
    actual_received_quantity: 10,
    accepted_quantity: 10,
  });
  assert.deepEqual(updateGrvReceivedQuantity({
    actual_received_quantity: 10,
    accepted_quantity: 10,
  }, 8), {
    actual_received_quantity: 8,
    accepted_quantity: 8,
  });
});

test("changing received quantity preserves a manually adjusted accepted quantity", () => {
  assert.deepEqual(updateGrvReceivedQuantity({
    actual_received_quantity: 10,
    accepted_quantity: 7,
  }, 12), {
    actual_received_quantity: 12,
    accepted_quantity: 7,
  });
});

test("GRV decimal inputs accept comma and point separators", () => {
  assert.equal(parseGrvDecimal("12,75"), 12.75);
  assert.equal(parseGrvDecimal("12.75"), 12.75);
  assert.equal(parseGrvDecimal("1.234,56"), 1234.56);
});

test("GRV totals include custom VAT without changing line values", () => {
  assert.deepEqual(grvTotals([
    { accepted_quantity: 2, unit_cost: "10,25" },
    { accepted_quantity: 1, unit_cost: "5.50" },
  ], "15,5"), {
    subtotal: 26,
    taxableSubtotal: 26,
    vatAmount: 4.03,
    freightAmount: 0,
    total: 30.03,
  });
});

test("chemical 12 barrels of 270 KG at R16 per KG calculate R51840", () => {
  const line = {
    accepted_quantity: 12,
    container_count: 12,
    container_capacity: 270,
    price_basis: "per_unit",
    unit: "KG",
    unit_cost: 16,
  };
  assert.deepEqual(grvLineCalculations(line), {
    containerCount: 12,
    containerCapacity: 270,
    totalQuantity: 3240,
    priceBasis: "per_unit",
    subtotal: 51840,
  });
  assert.equal(grvTotals([line], 15, 0).total, 59616);
});

test("chemical barrel price basis charges per container", () => {
  assert.equal(grvLineCalculations({
    container_count: 12,
    container_capacity: 270,
    price_basis: "per_container",
    unit: "KG",
    unit_cost: 16,
  }).subtotal, 192);
});

test("freight cost is included in the GRV taxable subtotal", () => {
  assert.deepEqual(grvTotals([
    { accepted_quantity: 12, container_count: 12, container_capacity: 270, price_basis: "per_unit", unit: "KG", unit_cost: 16 },
  ], 15, 10500), {
    subtotal: 51840,
    taxableSubtotal: 62340,
    vatAmount: 9351,
    freightAmount: 10500,
    total: 71691,
  });
});

test("GRV totals include freight cost separately", () => {
  assert.deepEqual(grvTotals([
    { accepted_quantity: 10, unit_cost: 10 },
  ], 15, "250"), {
    subtotal: 100,
    taxableSubtotal: 350,
    vatAmount: 52.5,
    freightAmount: 250,
    total: 402.5,
  });
});
