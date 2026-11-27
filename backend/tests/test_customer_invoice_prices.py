import asyncio
from copy import deepcopy
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

import server


class FakeCustomers:
    def __init__(self, document):
        self.document = deepcopy(document)

    async def find_one(self, query, _projection=None):
        if query.get("id") != self.document.get("id"):
            return None
        return deepcopy(self.document)


def install_customer_db(monkeypatch, document):
    customers = FakeCustomers(document)
    monkeypatch.setattr(server, "db", SimpleNamespace(customers=customers))

    async def fake_update_doc(collection, record_id, values):
        assert collection == "customers"
        assert record_id == customers.document["id"]
        customers.document.update(deepcopy(values))
        return deepcopy(customers.document)

    async def fake_log_audit(*_args, **_kwargs):
        return None

    monkeypatch.setattr(server, "update_doc", fake_update_doc)
    monkeypatch.setattr(server, "log_audit", fake_log_audit)
    return customers


@pytest.mark.parametrize(
    "company_id",
    ["superiqfoam", "iqfoam-manufactoring", "iqfoam-whole-sallers", "imraan-plastics"],
)
def test_customer_invoice_prices_can_be_read_in_each_company(monkeypatch, company_id):
    saved = [{"zone": 1, "category": "Simple", "size": "910x100", "price": 42}]
    install_customer_db(monkeypatch, {"id": "customer-1", "invoice_prices": saved})
    token = server.active_company_id.set(company_id)
    try:
        result = asyncio.run(server.get_customer_invoice_prices("customer-1", user={"role": "owner"}))
    finally:
        server.active_company_id.reset(token)

    assert result == saved


def test_fixed_price_company_saves_prices_in_zone_one_and_preserves_other_products(monkeypatch):
    original = [
        {"zone": 1, "category": "Simple", "size": "910x100", "price": 42},
        {"zone": 1, "category": "Ribbon Black", "size": "1370x150", "price": 55},
    ]
    customers = install_customer_db(monkeypatch, {"id": "customer-1", "invoice_prices": original})
    body = server.CustomerInvoicePricesIn(items=[
        {"zone": 2, "category": "Simple", "size": "910x100", "price": 44},
        {"zone": 2, "category": "Simple", "size": "1070x100", "price": 50},
    ])
    token = server.active_company_id.set("iqfoam-manufactoring")
    try:
        result = asyncio.run(server.save_customer_invoice_prices(
            "customer-1", body, user={"role": "owner"},
        ))
    finally:
        server.active_company_id.reset(token)

    assert result[0] == {"zone": 1, "category": "Simple", "size": "910x100", "price": 44.0}
    assert result[1] == original[1]
    assert result[2]["zone"] == 1 and result[2]["size"] == "1070x100"
    assert customers.document["invoice_prices"] == result


def test_zone_company_keeps_zone_and_freeform_company_saves_description(monkeypatch):
    install_customer_db(monkeypatch, {"id": "customer-1", "invoice_prices": []})
    zone_body = server.CustomerInvoicePricesIn(items=[
        {"zone": 2, "category": "Standard", "size": "910x100", "price": 44},
    ])
    token = server.active_company_id.set("superiqfoam")
    try:
        zone_result = asyncio.run(server.save_customer_invoice_prices(
            "customer-1", zone_body, user={"role": "owner"},
        ))
    finally:
        server.active_company_id.reset(token)
    assert zone_result[0]["zone"] == 2

    freeform_body = server.CustomerInvoicePricesIn(items=[
        {"description": "Foam packaging", "price": 18},
    ])
    token = server.active_company_id.set("imraan-plastics")
    try:
        freeform_result = asyncio.run(server.save_customer_invoice_prices(
            "customer-1", freeform_body, user={"role": "owner"},
        ))
    finally:
        server.active_company_id.reset(token)
    assert any(
        item["description"] == "Foam packaging" and item["zone"] == 1
        for item in freeform_result
    )


def test_worker_without_invoice_price_permission_cannot_save_customer_price(monkeypatch):
    install_customer_db(monkeypatch, {"id": "customer-1", "invoice_prices": []})
    token = server.active_company_id.set("superiqfoam")
    try:
        with pytest.raises(HTTPException) as error:
            asyncio.run(server.save_customer_invoice_prices(
                "customer-1",
                server.CustomerInvoicePricesIn(items=[
                    {"zone": 1, "category": "Standard", "size": "910x100", "price": 44},
                ]),
                user={"is_worker": True, "_active_role": "user", "worker_can_edit_invoice_prices": False},
            ))
    finally:
        server.active_company_id.reset(token)
    assert error.value.status_code == 403
