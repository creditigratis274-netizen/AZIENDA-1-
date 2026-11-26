import test from "node:test";
import assert from "node:assert/strict";
import { invoiceMatchesCustomer, invoiceOrderItems } from "./orderInvoiceSelection.mjs";

test("invoice customer matching supports IDs and normalized legacy names", () => {
  assert.equal(invoiceMatchesCustomer(
    { customer_id: "customer-1", customer_name: "Customer A" },
    { id: "customer-1", name: "Other Name" },
  ), true);
  assert.equal(invoiceMatchesCustomer(
    { customer_name: "  Customer   A " },
    { id: "missing", name: "customer a" },
  ), true);
});

test("invoice order items exclude empty rows and preserve product fields", () => {
  assert.deepEqual(invoiceOrderItems({ items: [
    { qty: 2, category: "Ribbon", size: "760x100" },
    { qty: 0, category: "Candy", size: "910x50" },
    { qty: 3, description: "Custom mattress" },
  ] }), [
    { qty: 2, category: "Ribbon", size: "760x100", description: "" },
    { qty: 3, category: "", size: "", description: "Custom mattress" },
  ]);
});
