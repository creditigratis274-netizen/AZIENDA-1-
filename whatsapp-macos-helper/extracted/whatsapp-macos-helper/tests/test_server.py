import json
import threading
import tempfile
import unittest
from pathlib import Path
from subprocess import CompletedProcess
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from unittest.mock import patch

from server import (
    HelperServer,
    RequestError,
    load_config,
    make_initial_config,
    open_whatsapp,
    parse_multipart,
    save_invoice,
    validate_origin,
    validate_request,
    write_initial_config,
)


PDF = b"%PDF-1.7\ninvoice test\n%%EOF\n"
TOKEN = "t" * 48
ORIGIN = "http://localhost:5173"


def multipart(fields, boundary="TestBoundary123"):
    chunks = []
    for name, value, filename, content_type in fields:
        chunks.extend(
            [
                f"--{boundary}\r\n".encode(),
                (
                    f'Content-Disposition: form-data; name="{name}"'
                    + (f'; filename="{filename}"' if filename else "")
                    + "\r\n"
                ).encode(),
                f"Content-Type: {content_type}\r\n\r\n".encode(),
                value if isinstance(value, bytes) else value.encode(),
                b"\r\n",
            ]
        )
    chunks.append(f"--{boundary}--\r\n".encode())
    return f"multipart/form-data; boundary={boundary}", b"".join(chunks)


def valid_fields():
    return [
        ("phone", "+14155552671", None, "text/plain"),
        ("message", "Invoice for May", None, "text/plain; charset=utf-8"),
        ("invoice_id", "invoice-123", None, "text/plain"),
        ("company_id", "company-456", None, "text/plain"),
        ("invoice", PDF, "Invoice-123.pdf", "application/pdf"),
    ]


class RequestValidationTests(unittest.TestCase):
    def test_accepts_valid_multipart_and_normalizes_phone(self):
        content_type, body = multipart(valid_fields())
        self.assertEqual(
            validate_request(content_type, body),
            ("14155552671", "Invoice for May", "invoice-123", "company-456", PDF, "Invoice-123.pdf"),
        )

    def test_rejects_missing_and_duplicate_fields(self):
        content_type, body = multipart(valid_fields()[:-1])
        with self.assertRaisesRegex(RequestError, "Provide phone"):
            validate_request(content_type, body)

        fields = valid_fields() + [("phone", "+14155552671", None, "text/plain")]
        content_type, body = multipart(fields)
        with self.assertRaisesRegex(RequestError, "Duplicate"):
            parse_multipart(content_type, body)

    def test_rejects_invalid_phone_message_mode_and_pdf(self):
        invalid_cases = [
            (0, "customer@example.com"),
            (1, " \n "),
            (2, "../invoice-123"),
            (3, "company with spaces"),
        ]
        for field_index, invalid_value in invalid_cases:
            with self.subTest(field_index=field_index):
                fields = valid_fields()
                name, _, filename, content_type = fields[field_index]
                fields[field_index] = (
                    name,
                    invalid_value,
                    filename,
                    content_type,
                )
                request_type, body = multipart(fields)
                with self.assertRaises(RequestError):
                    validate_request(request_type, body)

        for invalid_pdf in (b"not a pdf", b"%PDF-1.7\nno end marker"):
            fields = valid_fields()
            fields[-1] = ("invoice", invalid_pdf, "Invoice-123.pdf", "application/pdf")
            request_type, body = multipart(fields)
            with self.assertRaisesRegex(RequestError, "valid PDF"):
                validate_request(request_type, body)

        fields = valid_fields()
        fields[-1] = ("invoice", PDF, "../Invoice-123.pdf", "application/pdf")
        request_type, body = multipart(fields)
        with self.assertRaisesRegex(RequestError, "safe PDF filename"):
            validate_request(request_type, body)

    def test_rejects_unexpected_and_non_utf8_fields(self):
        fields = valid_fields() + [("extra", "ignored", None, "text/plain")]
        request_type, body = multipart(fields)
        with self.assertRaisesRegex(RequestError, "Unexpected"):
            validate_request(request_type, body)

        fields = valid_fields()
        fields[1] = ("message", b"\xff", None, "text/plain")
        request_type, body = multipart(fields)
        with self.assertRaisesRegex(RequestError, "UTF-8"):
            validate_request(request_type, body)

    def test_rejects_invalid_boundary_and_oversized_pdf(self):
        with self.assertRaises(RequestError):
            parse_multipart("multipart/form-data; boundary=bad boundary", b"")
        fields = valid_fields()
        fields[-1] = (
            "invoice",
            b"%PDF-" + b"x" * (12 * 1024 * 1024) + b"%%EOF",
            "Invoice-123.pdf",
            "application/pdf",
        )
        request_type, body = multipart(fields)
        with self.assertRaisesRegex(RequestError, "12 MiB"):
            validate_request(request_type, body)


class ConfigTests(unittest.TestCase):
    def test_origin_requires_exact_http_origin(self):
        self.assertEqual(validate_origin(ORIGIN), ORIGIN)
        for invalid in (
            "*",
            "https://user@example.com",
            "https://example.com/path",
            "ftp://example.com",
            "https://example.com/",
        ):
            with self.subTest(origin=invalid), self.assertRaises(ValueError):
                validate_origin(invalid)

    def test_config_creation_is_private_and_never_overwrites(self):
        with tempfile.TemporaryDirectory() as temporary:
            config_path = Path(temporary) / "config.json"
            config = write_initial_config(config_path, [ORIGIN])
            self.assertEqual(config["erp_origins"], [ORIGIN])
            self.assertGreaterEqual(len(config["token"]), 40)
            self.assertEqual(config_path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(load_config(config_path), config)
            with self.assertRaises(FileExistsError):
                write_initial_config(config_path, [ORIGIN])

    def test_empty_origin_list_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "at least one"):
            make_initial_config([])


class InvoiceAndLaunchTests(unittest.TestCase):
    def test_invoice_is_saved_private_and_named_randomly(self):
        with tempfile.TemporaryDirectory() as temporary:
            outbox = Path(temporary) / "outbox"
            invoice_path = save_invoice(PDF, "Invoice-123.pdf", outbox)
            self.assertEqual(invoice_path.read_bytes(), PDF)
            self.assertEqual(invoice_path.stat().st_mode & 0o777, 0o600)
            self.assertEqual(outbox.stat().st_mode & 0o777, 0o700)
            self.assertRegex(invoice_path.name, r"^[0-9a-f]{8}_Invoice-123\.pdf$")

    @patch("server.sys.platform", "darwin")
    @patch("server.subprocess.run")
    def test_desktop_launches_chat_and_requires_verified_attachment(self, run):
        invoice_path = Path("/tmp/abc12345_Invoice-123.pdf")
        run.side_effect = [
            CompletedProcess([], 0, "", ""),
            CompletedProcess([], 0, "ATTACHED:abc12345_Invoice-123.pdf\n", ""),
        ]
        result = open_whatsapp("14155552671", "Invoice for May", invoice_path)
        self.assertEqual(result, invoice_path.name)
        self.assertEqual(run.call_count, 2)
        self.assertEqual(
            run.call_args_list[0].args[0],
            ["open", "-a", "WhatsApp", "whatsapp://send?phone=14155552671&text=Invoice+for+May"],
        )
        self.assertEqual(run.call_args_list[1].args[0][:2], ["osascript", "-e"])
        self.assertEqual(run.call_args_list[1].args[0][3], str(invoice_path))
        self.assertEqual(run.call_args_list[1].args[0][4], "false")
        script = run.call_args_list[1].args[0][2]
        self.assertIn('set sendAutomatically to item 2 of argv', script)
        self.assertLess(script.index("if not pickerOpen then error"), script.index("keystroke invoicePath"))
        self.assertIn("if not filenameVisible or not sendButtonVisible then error", script)
        self.assertTrue(all(call.kwargs["check"] for call in run.call_args_list))

    @patch("server.subprocess.run")
    def test_attachment_automation_is_mac_only(self, run):
        with patch("server.sys.platform", "linux"), self.assertRaisesRegex(RuntimeError, "only on macOS"):
            open_whatsapp("14155552671", "Hello", Path("/tmp/invoice.pdf"))
        run.assert_not_called()

    @patch("server.sys.platform", "darwin")
    @patch("server.subprocess.run")
    def test_wrong_attachment_confirmation_is_a_failure(self, run):
        run.side_effect = [
            CompletedProcess([], 0, "", ""),
            CompletedProcess([], 0, "ATTACHED:other.pdf\n", ""),
        ]
        with self.assertRaisesRegex(RuntimeError, "did not confirm"):
            open_whatsapp("14155552671", "Hello", Path("/tmp/expected.pdf"))


class HandlerTests(unittest.TestCase):
    def setUp(self):
        config = {"token": TOKEN, "erp_origins": [ORIGIN]}
        self.server = HelperServer(("127.0.0.1", 0), config)
        self.port = self.server.server_address[1]
        self.port_patch = patch("server.PORT", self.port)
        self.port_patch.start()
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        if self.server.idle_timer:
            self.server.idle_timer.cancel()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.port_patch.stop()

    def request(self, path, *, method="GET", headers=None, body=None):
        request = Request(
            f"http://127.0.0.1:{self.port}{path}",
            data=body,
            headers=headers or {},
            method=method,
        )
        try:
            response = urlopen(request, timeout=2)
        except HTTPError as error:
            response = error
        return response.status, json.loads(response.read() or b"{}"), response.headers

    def test_health_reports_manual_workflow(self):
        status, response, headers = self.request("/health")
        self.assertEqual(status, 200)
        self.assertEqual(response, {"ok": True, "send_automatically": False})
        self.assertEqual(headers["Cache-Control"], "no-store")

    def test_wrong_authorization_and_origin_are_rejected(self):
        status, response, _ = self.request(
            "/api/v1/whatsapp",
            method="POST",
            headers={
                "Authorization": "Bearer wrong",
                "Origin": ORIGIN,
                "Content-Length": "0",
            },
            body=b"",
        )
        self.assertEqual(status, 401)
        self.assertEqual(response["error"], "Valid bearer token required.")

        status, response, _ = self.request(
            "/health",
            headers={"Origin": "https://untrusted.example"},
        )
        self.assertEqual(status, 403)
        self.assertEqual(response["error"], "Origin is not allowed.")

    @patch("server.open_whatsapp")
    @patch("server.save_invoice")
    def test_authenticated_request_stages_pdf_and_never_sends(self, save, open_whatsapp):
        invoice_path = Path("/private/tmp/abc12345_Invoice-123.pdf")
        save.return_value = invoice_path
        open_whatsapp.return_value = invoice_path.name
        content_type, body = multipart(valid_fields())
        status, response, _ = self.request(
            "/api/v1/whatsapp",
            method="POST",
            headers={
                "Authorization": f"Bearer {TOKEN}",
                "Origin": ORIGIN,
                "Content-Type": content_type,
            },
            body=body,
        )
        self.assertEqual(status, 200)
        self.assertEqual(
            response,
            {
                "ok": True,
                "invoice": invoice_path.name,
                "invoice_id": "invoice-123",
                "company_id": "company-456",
                "attached": True,
                "sent": False,
            },
        )
        save.assert_called_once_with(PDF, "Invoice-123.pdf")
        open_whatsapp.assert_called_once_with("14155552671", "Invoice for May", invoice_path)


if __name__ == "__main__":
    unittest.main()
