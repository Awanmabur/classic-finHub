# Operating handbook exports

The canonical source is `docs/OPERATIONS_MANUAL.md`. The editable Word and printable HTML exports are generated without database or application access:

```bash
python3 -m pip install python-docx
python3 tools/docs/build_operations_manual.py --edition "10 November 2026"
# With Playwright available as optional documentation tooling:
node tools/docs/print_operations_manual.cjs
```

Open `docs/operations/OPERATIONS_MANUAL.html` in a browser to print/save a PDF. The checked-in PDF is also generated from this HTML in Chromium with A4 paper and page-number footers. Set `CHROMIUM_PATH` when using a system Chromium executable. The documentation tool is optional development tooling and is not part of the production Node.js runtime.

After editing the source, regenerate the exports and inspect the cover, tables and page breaks. Use the current production runbook for host-level deployment and recovery procedures; the operating handbook does not replace that runbook.
