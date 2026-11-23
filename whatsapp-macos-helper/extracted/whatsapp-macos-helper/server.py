#!/usr/bin/env python3
"""Loopback-only WhatsApp helper for SUPER IQ-FOAM ERP."""

from __future__ import annotations

import argparse
import hmac
import json
import os
import re
import secrets
import stat
import subprocess
import sys
import threading
import time
import uuid
from email import policy
from email.parser import BytesParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlencode, urlsplit


HOST = "127.0.0.1"
PORT = 8765
MAX_PDF_BYTES = 12 * 1024 * 1024
MAX_REQUEST_BYTES = MAX_PDF_BYTES + 64 * 1024
MAX_MESSAGE_CHARS = 4096
CONFIG_PATH = (
    Path.home()
    / "Library"
    / "Application Support"
    / "SuperIQFoamWhatsAppHelper"
    / "config.json"
)
LOG_PATH = (
    Path.home()
    / "Library"
    / "Application Support"
    / "SuperIQFoamWhatsAppHelper"
    / "helper.log"
)
OUTBOX_PATH = (
    Path.home()
    / "Library"
    / "Application Support"
    / "SuperIQFoamWhatsAppHelper"
    / "outbox"
)
PHONE_RE = re.compile(r"^\+?[1-9][0-9]{7,14}$")
BOUNDARY_RE = re.compile(r"^[A-Za-z0-9'()+_,./:=?-]{1,70}$")
EXPECTED_FIELDS = {"phone", "message", "invoice_id", "company_id", "invoice"}
FILE_RETENTION_SECONDS = 24 * 60 * 60
SAFE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
SAFE_FILENAME_RE = re.compile(r"^[A-Za-z0-9._ -]{1,120}\.pdf$", re.IGNORECASE)

ATTACH_APPLESCRIPT = r'''
on textOf(uiItem)
  set combinedText to ""
  try
    set combinedText to combinedText & " " & (name of uiItem as text)
  end try
  try
    set combinedText to combinedText & " " & (description of uiItem as text)
  end try
  try
    set combinedText to combinedText & " " & (value of uiItem as text)
  end try
  return combinedText
end textOf

on run argv
  set invoicePath to item 1 of argv
  set invoiceName to do shell script "basename " & quoted form of invoicePath
  tell application "System Events"
    tell process "WhatsApp"
      set frontmost to true
    set attachControl to missing value
    repeat 40 times
      if exists window 1 then
        set allElements to entire contents of window 1
        repeat with uiItem in allElements
          set elementRole to ""
          try
            set elementRole to role of uiItem as text
          end try
          if elementRole is "AXButton" then
            set labelText to my textOf(uiItem)
            if labelText contains "Attach" or labelText contains "attachment" or labelText contains "Paperclip" or labelText contains "Allega" or labelText contains "Adjuntar" then
              set attachControl to uiItem
              exit repeat
            end if
          end if
        end repeat
      end if
      if attachControl is not missing value then exit repeat
      delay 0.5
    end repeat
    if attachControl is missing value then error "WhatsApp attachment control was not recognized; no file was attached."
    click attachControl
    delay 0.5

    set documentControl to missing value
    repeat 20 times
      set allElements to entire contents of process "WhatsApp"
      repeat with uiItem in allElements
        set elementRole to ""
        try
          set elementRole to role of uiItem as text
        end try
        if elementRole is "AXMenuItem" or elementRole is "AXButton" then
          set labelText to my textOf(uiItem)
          if labelText contains "Document" or labelText contains "document" or labelText contains "Documento" or labelText contains "File" then
            set documentControl to uiItem
            exit repeat
          end if
        end if
      end repeat
      if documentControl is not missing value then exit repeat
      delay 0.25
    end repeat
      if documentControl is missing value then error "WhatsApp document picker option was not recognized; no file was attached."
      click documentControl
      delay 0.8

      set pickerOpen to false
      repeat 20 times
        if exists window "Open" or exists sheet 1 of window 1 then
          set pickerOpen to true
          exit repeat
        end if
        delay 0.25
      end repeat
      if not pickerOpen then error "The macOS file picker did not open; no keyboard input was sent."

      keystroke "g" using {command down, shift down}
      delay 0.3
      if not (exists sheet 1 of window 1) and not (exists window "Go to Folder") then
        error "The file picker's location field was not recognized; no path was entered."
      end if
      keystroke invoicePath
      key code 36
      delay 0.5
      if not (exists window "Open") and not (exists sheet 1 of window 1) then
        error "The file picker closed before the invoice could be selected."
      end if
      key code 36
      delay 0.5
      set filenameVisible to false
      set sendButtonVisible to false
      set sendButtonControl to missing value
      repeat 30 times
        set allElements to entire contents of process "WhatsApp"
        repeat with uiItem in allElements
          set labelText to my textOf(uiItem)
          if labelText contains invoiceName then set filenameVisible to true
          set elementRole to ""
          try
            set elementRole to role of uiItem as text
          end try
          if elementRole is "AXButton" and (labelText contains "Send" or labelText contains "Invia" or labelText contains "Enviar") then
            set sendButtonVisible to true
            set sendButtonControl to uiItem
          end if
        end repeat
        if filenameVisible and sendButtonVisible then exit repeat
        delay 0.5
      end repeat
      if not filenameVisible or not sendButtonVisible then error "WhatsApp did not confirm the selected invoice in its attachment preview."
      set sendAutomatically to item 2 of argv
      if sendAutomatically is "true" and sendButtonControl is not missing value then
        click sendButtonControl
      end if
      return "ATTACHED:" & invoiceName
    end tell
  end tell
end run
'''


class RequestError(ValueError):
    """A safe, client-facing request validation error."""


def write_log(message: str) -> None:
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {message}\n".encode("utf-8")
    stream = sys.stderr if sys.stderr is not None else sys.stdout
    if stream is not None:
        stream.write(line.decode("utf-8"))
        stream.flush()
        return
    LOG_PATH.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor = os.open(LOG_PATH, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        os.chmod(LOG_PATH, 0o600)
        os.write(descriptor, line)
    finally:
        os.close(descriptor)


def validate_origin(origin: str) -> str:
    if not isinstance(origin, str):
        raise ValueError(f"Not an exact HTTP(S) origin: {origin!r}")
    parsed = urlsplit(origin)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.path
        or parsed.query
        or parsed.fragment
        or origin.endswith("/")
    ):
        raise ValueError(f"Not an exact HTTP(S) origin: {origin!r}")
    try:
        parsed.port
    except ValueError as exc:
        raise ValueError(f"Invalid origin port: {origin!r}") from exc
    return origin


def make_initial_config(origins: list[str], send_automatically: bool = False) -> dict[str, object]:
    if not origins:
        raise ValueError("Provide at least one trusted ERP origin.")
    validated = list(dict.fromkeys(validate_origin(origin) for origin in origins))
    return {"token": secrets.token_urlsafe(32), "erp_origins": validated, "send_automatically": send_automatically}


def write_initial_config(config_path: Path, origins: list[str], send_automatically: bool = False) -> dict[str, object]:
    config = make_initial_config(origins, send_automatically)
    config_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(config_path.parent, 0o700)
    try:
        descriptor = os.open(
            config_path,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL,
            0o600,
        )
    except FileExistsError as exc:
        raise FileExistsError(f"Configuration already exists: {config_path}") from exc
    with os.fdopen(descriptor, "w", encoding="utf-8") as file:
        json.dump(config, file, indent=2)
        file.write("\n")
    return config


def load_config(config_path: Path) -> dict[str, object]:
    with config_path.open(encoding="utf-8") as file:
        config = json.load(file)
    if not isinstance(config, dict):
        raise ValueError("Configuration must be a JSON object.")
    token = config.get("token")
    origins = config.get("erp_origins")
    if not isinstance(token, str) or len(token) < 40:
        raise ValueError("Configuration token must be at least 40 characters.")
    if not isinstance(origins, list) or not origins:
        raise ValueError("Configuration must include trusted ERP origins.")
    validated = [validate_origin(origin) for origin in origins]
    send_automatically = config.get("send_automatically") is True
    return {"token": token, "erp_origins": validated, "send_automatically": send_automatically}


def parse_multipart(content_type: str, body: bytes) -> dict[str, tuple[bytes, str | None, str]]:
    media_type, separator, parameters = content_type.partition(";")
    if not separator or media_type.strip().lower() != "multipart/form-data":
        raise RequestError("Content-Type must be multipart/form-data.")
    boundary_match = re.search(
        r'(?:^|;)\s*boundary=(?:"([^"]+)"|([^;\s]+))',
        ";" + parameters,
        flags=re.IGNORECASE,
    )
    boundary = (boundary_match.group(1) or boundary_match.group(2)) if boundary_match else ""
    if not BOUNDARY_RE.fullmatch(boundary):
        raise RequestError("Invalid multipart boundary.")

    try:
        content_type_bytes = content_type.encode("ascii", "strict")
    except UnicodeEncodeError as exc:
        raise RequestError("Content-Type must contain ASCII headers.") from exc
    message = BytesParser(policy=policy.default).parsebytes(
        b"Content-Type: "
        + content_type_bytes
        + b"\r\nMIME-Version: 1.0\r\n\r\n"
        + body
    )
    if not message.is_multipart():
        raise RequestError("Malformed multipart request.")
    fields: dict[str, tuple[bytes, str | None, str]] = {}
    for part in message.iter_parts():
        if part.get_content_disposition() != "form-data":
            raise RequestError("Unexpected multipart section.")
        name = part.get_param("name", header="content-disposition")
        if not isinstance(name, str) or name not in EXPECTED_FIELDS:
            raise RequestError("Unexpected form field.")
        if name in fields:
            raise RequestError("Duplicate form field.")
        payload = part.get_payload(decode=True)
        if not isinstance(payload, bytes):
            raise RequestError("Invalid form field data.")
        filename = part.get_filename()
        media_type = part.get_content_type().lower()
        fields[name] = (payload, filename, media_type)
    if set(fields) != EXPECTED_FIELDS:
        raise RequestError("Provide phone, message, mode, and invoice fields.")
    return fields


def decode_text_field(fields: dict[str, tuple[bytes, str | None, str]], name: str) -> str:
    payload, filename, _ = fields[name]
    if filename is not None:
        raise RequestError(f"{name} must be a text field.")
    try:
        return payload.decode("utf-8", "strict")
    except UnicodeDecodeError as exc:
        raise RequestError(f"{name} must be UTF-8 text.") from exc


def validate_request(content_type: str, body: bytes) -> tuple[str, str, str, str, bytes, str]:
    fields = parse_multipart(content_type, body)
    phone = decode_text_field(fields, "phone")
    if not PHONE_RE.fullmatch(phone) or not phone.startswith("+"):
        raise RequestError("Phone must use international format, e.g. +14155552671.")
    message = decode_text_field(fields, "message")
    if (
        not message.strip()
        or len(message) > MAX_MESSAGE_CHARS
        or any(ord(char) < 32 and char not in "\r\n\t" for char in message)
    ):
        raise RequestError("Message must be 1–4096 characters without control characters.")
    invoice_id = decode_text_field(fields, "invoice_id")
    company_id = decode_text_field(fields, "company_id")
    if not SAFE_ID_RE.fullmatch(invoice_id) or not SAFE_ID_RE.fullmatch(company_id):
        raise RequestError("Invoice and company IDs contain invalid characters.")
    invoice, filename, media_type = fields["invoice"]
    if (
        not filename
        or not SAFE_FILENAME_RE.fullmatch(filename)
        or ".." in filename
        or media_type != "application/pdf"
    ):
        raise RequestError("Invoice must have a safe PDF filename and application/pdf type.")
    if not invoice or len(invoice) > MAX_PDF_BYTES:
        raise RequestError("PDF must be between 1 byte and 12 MiB.")
    if not invoice.startswith(b"%PDF-") or b"%%EOF" not in invoice[-1024:]:
        raise RequestError("Invoice does not have a valid PDF header and trailer.")
    return phone.lstrip("+"), message, invoice_id, company_id, invoice, filename


def save_invoice(
    pdf_data: bytes, filename: str, outbox_path: Path = OUTBOX_PATH
) -> Path:
    outbox_path.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(outbox_path, 0o700)
    now = time.time()
    for candidate in outbox_path.glob("*.pdf"):
        try:
            info = candidate.stat(follow_symlinks=False)
            if (
                stat.S_ISREG(info.st_mode)
                and now - info.st_mtime > FILE_RETENTION_SECONDS
            ):
                candidate.unlink()
        except FileNotFoundError:
            continue

    destination = outbox_path / f"{uuid.uuid4().hex[:8]}_{filename}"
    descriptor = os.open(
        destination,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL,
        0o600,
    )
    with os.fdopen(descriptor, "wb") as file:
        file.write(pdf_data)
    return destination


def open_whatsapp(phone: str, message: str, pdf_path: Path, send_automatically: bool = False) -> str:
    if sys.platform != "darwin":
        raise RuntimeError("WhatsApp Desktop attachment automation is supported only on macOS.")
    query = urlencode({"phone": phone, "text": message})
    try:
        subprocess.run(
            ["open", "-a", "WhatsApp", f"whatsapp://send?{query}"],
            check=True,
            timeout=15,
            capture_output=True,
            text=True,
        )
    except subprocess.CalledProcessError as exc:
        details = (exc.stderr or "").strip()
        raise RuntimeError(
            f"Could not open WhatsApp Desktop{': ' + details if details else '.'}"
        ) from exc
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("Timed out while opening WhatsApp Desktop.") from exc
    try:
        automation = subprocess.run(
            ["osascript", "-e", ATTACH_APPLESCRIPT, str(pdf_path), "true" if send_automatically else "false"],
            check=True,
            timeout=45,
            capture_output=True,
            text=True,
        )
    except subprocess.CalledProcessError as exc:
        details = (exc.stderr or "").strip()
        raise RuntimeError(
            f"macOS could not verify the attachment{': ' + details if details else '.'}"
        ) from exc
    except subprocess.TimeoutExpired as exc:
        raise RuntimeError("Timed out while automating WhatsApp; attachment is unverified.") from exc
    expected = f"ATTACHED:{pdf_path.name}"
    if automation.stdout.strip() != expected:
        raise RuntimeError(
            "WhatsApp did not confirm the exact invoice in its attachment preview."
        )
    return pdf_path.name


class HelperServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, server_address: tuple[str, int], config: dict[str, object]):
        super().__init__(server_address, HelperHandler)
        self.config = config
        self.idle_timer: threading.Timer | None = None

    def reset_idle_timeout(self) -> None:
        return


class HelperHandler(BaseHTTPRequestHandler):
    server: HelperServer
    protocol_version = "HTTP/1.1"
    server_version = "SuperIQFoamWhatsAppHelper/1"
    sys_version = ""

    def log_message(self, format_string: str, *args: object) -> None:
        # Do not log request content, invoice names, or credentials.
        write_log(f"{self.address_string()} - {format_string % args}")

    def _send_json(self, status: int, payload: dict[str, object]) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self._add_cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def _add_cors_headers(self) -> None:
        origin = self.headers.get("Origin")
        if origin and origin in self.server.config["erp_origins"]:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")

    def _check_origin_and_host(self) -> bool:
        host = self.headers.get("Host", "").lower()
        if host not in {f"127.0.0.1:{PORT}", f"localhost:{PORT}"}:
            self._send_json(400, {"error": "Invalid Host header."})
            return False
        origin = self.headers.get("Origin")
        if origin and origin not in self.server.config["erp_origins"]:
            self._send_json(403, {"error": "Origin is not allowed."})
            return False
        return True

    def _authorized(self) -> bool:
        supplied = self.headers.get("Authorization", "")
        expected = f"Bearer {self.server.config['token']}"
        if not hmac.compare_digest(supplied, expected):
            self._send_json(401, {"error": "Valid bearer token required."})
            return False
        return True

    def do_OPTIONS(self) -> None:
        if not self._check_origin_and_host():
            return
        origin = self.headers.get("Origin")
        if not origin:
            self._send_json(400, {"error": "Origin header required for preflight."})
            return
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.send_header("Cache-Control", "no-store")
        self._add_cors_headers()
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Max-Age", "300")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.end_headers()

    def do_GET(self) -> None:
        if self.path != "/health":
            self._send_json(404, {"error": "Not found."})
            return
        if not self._check_origin_and_host():
            return
        self._send_json(200, {"ok": True, "send_automatically": bool(self.server.config.get("send_automatically"))})

    def do_POST(self) -> None:
        if self.path != "/api/v1/whatsapp":
            self._send_json(404, {"error": "Not found."})
            return
        if not self._check_origin_and_host() or not self._authorized():
            return
        self.server.reset_idle_timeout()
        if self.headers.get("Transfer-Encoding"):
            self._send_json(400, {"error": "Transfer-Encoding is not supported."})
            return
        try:
            content_length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            self._send_json(411, {"error": "Content-Length is required."})
            return
        if content_length < 1 or content_length > MAX_REQUEST_BYTES:
            self._send_json(413, {"error": "Request is empty or exceeds the size limit."})
            return
        try:
            body = self.rfile.read(content_length)
            if len(body) != content_length:
                raise RequestError("Incomplete request body.")
            phone, message, invoice_id, company_id, pdf_data, filename = validate_request(
                self.headers.get("Content-Type", ""), body
            )
            pdf_path = save_invoice(pdf_data, filename)
            if self.server.config.get("send_automatically"):
                attached_filename = open_whatsapp(phone, message, pdf_path, True)
            else:
                attached_filename = open_whatsapp(phone, message, pdf_path)
        except RequestError as exc:
            self._send_json(400, {"error": str(exc)})
            return
        except (OSError, RuntimeError, subprocess.SubprocessError) as exc:
            self._send_json(502, {"error": f"WhatsApp could not verify the attachment: {exc}"})
            return
        self._send_json(
            200,
            {
                "ok": True,
                "invoice": attached_filename,
                "invoice_id": invoice_id,
                "company_id": company_id,
                "attached": True,
                "sent": bool(self.server.config.get("send_automatically")),
            },
        )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--config",
        type=Path,
        default=CONFIG_PATH,
        help=f"Configuration JSON path (default: {CONFIG_PATH})",
    )
    parser.add_argument(
        "--init",
        action="store_true",
        help="Create a private config with a new bearer token, then exit.",
    )
    parser.add_argument(
        "--send-automatically",
        action="store_true",
        help="After attachment verification, click WhatsApp Send automatically.",
    )
    parser.add_argument(
        "--origin",
        action="append",
        default=[],
        help="Exact ERP origin, repeat for more than one (used with --init).",
    )
    args = parser.parse_args()
    if args.init:
        try:
            write_initial_config(args.config, args.origin, args.send_automatically)
        except (OSError, ValueError) as exc:
            parser.error(str(exc))
        print(f"Private helper configuration created: {args.config}")
        print("Read the bearer token from this file; do not put it in a public bundle.")
        return 0

    try:
        config = load_config(args.config)
        server = HelperServer((HOST, PORT), config)
    except (OSError, ValueError) as exc:
        write_log(f"Cannot start helper: {exc}")
        return 2
    write_log(
        f"Listening only on http://{HOST}:{PORT} "
        "(leave running for scheduled Daily Report sends)."
    )
    write_log(f"Allowed ERP origins: {', '.join(config['erp_origins'])}")
    server.reset_idle_timeout()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        write_log("Stopping helper.")
    finally:
        if server.idle_timer:
            server.idle_timer.cancel()
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
