# CLAUDE.md - Claude-Specific Instructions

You are assisting with the NEARFall feasibility study.

**CRITICAL:** Please begin by reading `AGENTS.md` for project context, mission objectives, repository blueprint, conventions, and analysis instructions.

## Compaction and memory

When reloading files after compaction, do not reread files in `experiments/` unless there is a conversation underway that directly references them. (They tend to require a lot of memory, so we don't want to load them unnecessarily.)
