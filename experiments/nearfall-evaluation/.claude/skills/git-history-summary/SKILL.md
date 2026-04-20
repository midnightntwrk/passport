---
name: git-history-summary
description: Read and summarize recent git commits in this repository. Use when asked what has been done recently, what changed this week, what experiments were run, or to produce a progress summary. Triggers on "what changed", "recent commits", "what was done", "progress summary", "summarize commits", "this week's work", or "what's new".
allowed-tools: Bash
---

# Git History Summary

Summarise recent work in the NEARFall repository from git commit history.

## Step 1 — Fetch commits

Choose the right range for the question being asked:

```bash
# Last N commits
git log --oneline -20

# Since a date
git log --oneline --since="2026-04-10"

# This week
git log --oneline --since="$(date -d 'last monday' +%Y-%m-%d)" 2>/dev/null \
  || git log --oneline --since="$(date -v-mon +%Y-%m-%d)" 2>/dev/null \
  || git log --oneline --since="7 days ago"

# Between two commits or tags
git log --oneline v1.0..HEAD

# With file paths (to understand what areas changed)
git log --oneline --stat -10

# With full messages (for detailed summary)
git log --format="%h %as %s%n%b" -20
```

## Step 2 — Interpret commit subjects in context

This is a research repository. Map commit language to research activities:

| Commit language | Research meaning |
|----------------|-----------------|
| "Drafted …" / "Created …" | New assessment, document, or artifact produced |
| "Tweaked …" / "Updated …" | Iteration on existing work |
| "Meeting notes" / "Logbook" | Stakeholder activity, not code |
| "Added experiment" / "WIP" | Active code spike under way |
| "Merge pull request #N" | Completed branch / increment boundary |
| "Diagram" / "Slides" | Visual artifact for communication |
| "Fix" / "Patched" | Technical blocker resolved |

## Step 3 — Produce summary

Group by **activity area** (not individual files). Aim for 1 sentence per area.
Use the journal entry format from `AGENTS.md`: neutral tone, no jargon, no sub-points.

### Example output format

```
Week of 14–17 April 2026

- Hybrid sharding design: produced architecture diagram and design document
  for NEAR-inspired sharding adapted to Substrate.
- Executive findings: drafted high-level summary of feasibility study conclusions.
- Node infrastructure: tuned monitoring scripts and Kubernetes configs for
  the local LAN multi-node experiment.
- TEE computing: revised slide deck and created spectrum diagram contrasting
  TEE approaches.
```

## Step 4 — Optional: correlate with journal

If a more detailed summary is needed, cross-reference with the journal:

```bash
# Find journal entries modified in the same period
git log --oneline --since="7 days ago" -- journal/
```

Then read the relevant journal sections for richer context beyond what commit
messages contain.

## Common invocations

```
Summarise commits from the past week
What was done since the last PR merge?
What experiments were added this month?
Give me a progress summary for the project increment
```
