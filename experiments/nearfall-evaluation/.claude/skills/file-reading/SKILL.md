---
name: file-reading
description: Efficiently read and analyze project files. Use when exploring codebases, understanding file structure, or extracting information from source files.
allowed-tools: Read Glob Grep
---

## File Reading Strategy

1. **Glob first** — Find relevant files by name/extension before reading
2. **Grep for patterns** — Search content before reading entire files
3. **Read strategically** — Use `offset`/`limit` for large files
4. **Cite paths** — Reference exact absolute file paths in responses

### Common patterns

| Task | Approach |
|------|----------|
| Find markdown docs | `Glob(**/*.md)` then `Read` |
| Search code | `Grep(pattern)` then `Read` matching files |
| Find configs | `Glob(**/*.json, **/*.yaml)` |
| Explore structure | `Glob(src/**/*)` |

Always prefer dedicated tools (`Read`, `Glob`, `Grep`) over shell commands (`cat`, `find`, `grep`).
