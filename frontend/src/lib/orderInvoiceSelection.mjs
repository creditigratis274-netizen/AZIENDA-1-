export function normalizeInvoiceName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export function invoiceMatchesCustomer(invoice, customer) {
  if (!invoice || !customer) return false;
  if (invoice.customer_id && customer.id) return invoice.customer_id === customer.id;
  return normalizeInvoiceName(invoice.customer_name) !== ""
    && normalizeInvoiceName(invoice.customer_name) === normalizeInvoiceName(customer.name);
}

export function invoiceOrderItems(invoice) {
  return (invoice?.items || [])
    .filter((item) => Number(item?.qty) > 0
      && (item?.category || item?.size || item?.description))
    .map((item) => ({
      qty: item.qty,
      category: item.category || "",
      size: item.size || "",
      description: item.description || "",
    }));
}
