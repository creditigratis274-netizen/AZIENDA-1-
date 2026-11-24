import pytest

import server


@pytest.mark.parametrize(
    "payment, expected",
    [
        ({"include_on_daily_report": False}, True),
        ({"advance_payment": True, "include_on_daily_report": False}, True),
        ({"other_balance_payment": True, "include_on_daily_report": False}, True),
        ({"express": True, "include_on_daily_report": False}, True),
        (
            {
                "express": True,
                "daily_report_inclusion_set": True,
                "include_on_daily_report": False,
            },
            False,
        ),
        (
            {
                "daily_report_inclusion_set": True,
                "include_on_daily_report": True,
            },
            True,
        ),
    ],
)
def test_daily_report_payment_inclusion(payment, expected):
    assert server.daily_report_payment_included(payment) is expected
