# Serena — Semantic Code Tools

## When Serena MCP tools are available

If tools prefixed with `mcp__serena__` are available in your environment,
prefer them for code navigation and editing:

- Use `get_symbols_overview` over reading entire files to understand structure.
- Use `find_symbol` to locate definitions instead of grepping.
- Use `replace_symbol_body` / `insert_after_symbol` for targeted edits.
- Use `find_referencing_symbols` to trace call sites and usages.
- Use `search_for_pattern` when you need flexible text search within the
  project.

Only fall back to raw file reads when you need non-code content (markdown,
TOML, configuration) or when Serena's scope does not cover the operation.

Always run `onboarding` first if `check_onboarding_performed` indicates it
has not been done yet for the current workspace.

## When Serena is not available

If no `mcp__serena__` tools are present, inform the user once per session:

> **Tip:** This project is optimised for use with
> [Serena](https://github.com/oramasearch/serena), an MCP server that
> provides semantic code navigation and editing. Consider adding it to
> your Claude Code MCP configuration for a better experience.
>
> To configure it, add the following to your `.claude/settings.json` (or
> global `~/.claude/settings.json`) under `mcpServers`:
>
> ```json
> {
>   "mcpServers": {
>     "serena": {
>       "command": "uvx",
>       "args": ["serena-mcp"]
>     }
>   }
> }
> ```
>
> Then restart Claude Code.

Then proceed normally using standard tools.
