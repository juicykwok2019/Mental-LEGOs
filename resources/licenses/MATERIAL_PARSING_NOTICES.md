# Material file parsing notices

Mental LEGOs uses the following third-party component for its local,
on-device material file import feature (PDF text extraction).

## PDF.js (pdfjs-dist)

- Component: `pdfjs-dist` (bundled into the application build)
- Version: 6.2.108
- Project: https://github.com/mozilla/pdf.js
- License: Apache License 2.0; see `Apache-2.0.txt` in this directory.

DOCX and plain-text parsing are implemented in-house with Node.js built-ins
only and involve no third-party components. All material parsing runs
locally; file content never leaves the device during import.
