# SUPER IQ-FOAM WhatsApp invoice helper

The invoice detail page's **Send via WhatsApp** action renders that invoice through the ERP's existing PDF renderer, verifies invoice/company/customer identifiers, and sends the PDF plus the customer's saved phone and a prepared message to this Mac-local helper. The helper opens WhatsApp Desktop and uses macOS UI scripting to choose the exact PDF. It reports success only if WhatsApp's attachment preview exposes the generated filename and a Send control. It never clicks Send.

The helper does not use a paid API or third-party Python packages. Nothing changes in the database, invoice numbering, or deployment. When launched as a `.app`, startup and access-denied details are written to `~/Library/Application Support/SuperIQFoamWhatsAppHelper/helper.log`.

## What you need on the Mac

- macOS and Python 3 (`python3 --version`; install from python.org or `brew install python` if missing).
- WhatsApp Desktop installed and already signed in.
- The ERP open in a browser on the Mac. The browser origin must match the one configured below.
- A customer phone stored in international format, for example `+27123456789`. The helper deliberately rejects ambiguous local-only numbers rather than risk opening the wrong chat.

## One-time helper setup

Copy this folder to the Mac and open Terminal in `whatsapp-macos-helper`. Create a Python environment:

```sh
python3 -m venv .venv
source .venv/bin/activate
```

Create a private token and allow only the exact ERP browser origin. Use the actual address in the browser's address bar, with no route suffix:

For the explicit daily-report test that may press WhatsApp Send automatically, add `--send-automatically`:

```sh
python3 server.py --init --send-automatically --origin https://your-erp.example
```

This is an explicit opt-in. The helper verifies the exact PDF filename and Send control before clicking Send.

For manual attachment behavior, omit `--send-automatically`:

```sh
python3 server.py --init --origin https://your-erp.example
```

For a local Vite ERP, use `http://localhost:5173` instead. For multiple origins, add another `--origin` option to this *single* initialization command. The private config is written to `~/Library/Application Support/SuperIQFoamWhatsAppHelper/config.json`; it contains a random bearer token and has owner-only file/directory permissions. Do not copy the token into the ERP source, frontend build, Git, or a public place. The ERP asks for it in the button flow and keeps it in the current browser tab's session storage.

## Daily Report automatic test

Keep WhatsApp Desktop open and run the helper on the Mac. In the ERP Daily Report page, enter the private bearer token and enable `Send Daily Report at 17:00 to +39 350 959 2734`. The browser must remain open. At 17:00 it generates today's report PDF and sends it to the configured test number through the loopback helper.

The browser stores a dated send marker so the same report is not sent twice.

## Run only while preparing an invoice

There is no login item, launch agent, or permanent background installation. Before using the ERP button, start the helper in Terminal:

```sh
source .venv/bin/activate
python3 server.py
```

It listens only on `127.0.0.1:8765`, and its UI automation runs only after an authenticated ERP button request. It automatically exits after five minutes without an authenticated request, so you can prepare several invoices during one short session. This requires starting the helper before clicking the ERP action: browsers cannot start a local Mac executable directly. It does not install a login item or a permanent service.

## macOS permission

The helper's attachment step requires macOS Accessibility/UI scripting so it can operate WhatsApp's attachment picker. Do not grant permission before trying the workflow. When macOS asks, authorize only the actual helper application. To provide a named app identity, build the optional `.app` bundle below and launch it instead of the Python command; then enable **SUPER IQ-FOAM WhatsApp Helper.app** in **System Settings → Privacy & Security → Accessibility**. If macOS displays an Automation prompt for the helper to control System Events, explicitly approve that prompt. Never enable Terminal or bypass a prompt as a workaround. Restart the helper after changing permissions.

The `.app` bundle build is done on the Mac; this Linux repository environment cannot build or verify macOS permissions/UI behavior.

```sh
source .venv/bin/activate
python3 -m pip install --upgrade pyinstaller
pyinstaller --noconfirm --clean --windowed \
  --name "SUPER IQ-FOAM WhatsApp Helper" \
  --osx-bundle-identifier com.superiqfoam.whatsapp-helper \
  server.py
```

The bundle is `dist/SUPER IQ-FOAM WhatsApp Helper.app`. Run it from Finder when using the ERP; it reads the same config and serves until a five-minute idle timeout or quit. The app bundle does not register a URL scheme or start itself from the ERP; the helper must already be open when you click the ERP button.

## Test

Run unit tests:

```sh
python3 -m unittest discover -s tests -v
```

In another Terminal window, start the one-request helper and check loopback health:

```sh
python3 server.py
curl --fail http://127.0.0.1:8765/health
```

Then open an issued, active invoice in the ERP and click **Send via WhatsApp**. On the first use in that browser tab, paste the token from the private config. The test should open WhatsApp Desktop to the customer's saved number with the prepared message and open the invoice document preview. Verify the customer, invoice number, PDF, and text; press Send yourself only if correct. The helper exits five minutes after the last authenticated request.

This repository environment is Linux, so tests here can verify input validation, loopback/auth behavior, and that success requires an explicit UI-automation confirmation, but cannot validate macOS Accessibility, WhatsApp labels, customer chat navigation, or an actual attachment. Perform the Mac test with one non-sensitive invoice before real use.

## If WhatsApp changes or automation fails

WhatsApp Desktop's accessibility labels and attachment picker are not a stable public automation API. If the helper cannot recognize the Attach/Document controls, the file dialog, or the exact filename in the attachment preview, it returns an error and does **not** claim the PDF is attached. It may have opened the chat, but you must manually attach the PDF and inspect it. Use the ERP's existing **Download PDF** action, open the customer's chat, choose Attach → Document in WhatsApp, select that downloaded invoice, and review/send manually. Do not press Send if the correct invoice is not visibly attached.

## Local API and safeguards

`POST http://127.0.0.1:8765/api/v1/whatsapp` requires the generated bearer token and exact configured ERP origin. It accepts only phone, message, invoice ID, company ID, and a PDF upload. The helper rejects unsafe IDs/names, malformed phone numbers, invalid/oversized PDFs, unknown/duplicate fields, unexpected Host/Origin, and unauthenticated requests. It never accepts a caller-selected file path; it creates a random private filename in the helper-owned outbox. Files are mode `0600`, the folder is `0700`, and old regular PDFs are removed after 24 hours.

The `attached: true` response is returned only after the macOS automation reports the exact staged filename visible in the WhatsApp attachment preview. Every successful response also has `sent: false`.
