---
name: skill-creator
description: Creates new custom skills for Claude Code. Use when you have a repeating workflow, checklist, or playbook you keep using.
disable-model-invocation: true
argument-hint: "[skill-name] [description]"
---

Create a new skill named `$0` with the following description: $1

Steps:
1. Create the directory `.claude/skills/$0/`
2. Create `SKILL.md` with appropriate frontmatter and instructions
3. Test by invoking with `/$0`
4. Commit to version control

Guidelines:
- Use lowercase with hyphens for skill names
- Write a `description` that helps Claude understand when to auto-invoke
- Keep `SKILL.md` under 500 lines; move detailed content to supporting files
- Add `disable-model-invocation: true` for workflows you only invoke manually
- Add `allowed-tools` to pre-approve specific tools without prompts
