---
name: pdf-reading
description: Read and analyze PDF documents. Use when working with PDFs, extracting text, analyzing diagrams, or summarizing document contents.
allowed-tools: Read
---

## PDF Analysis Workflow

1. **Use absolute paths** when specifying PDF files
2. **Specify page ranges** for PDFs over 10 pages (max 20 pages per request): `pages: "1-5"`
3. **Extract structured information** — ask for specific data, summaries, or transcriptions
4. **Describe visuals** — diagrams, charts, and layouts can be analyzed directly

### PDFs in this project

| File | Description |
|------|-------------|
| `artifacts/findings-briefing-20260417.pdf` | Latest findings briefing |
| `background/proving-nothing.pdf` | Background reading |
| `background/secure-onboarding-design.pdf` | Secure onboarding design |

Use the `Read` tool with the `pages` parameter for large PDFs to stay within context limits.
