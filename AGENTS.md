# Repository Guidance

Applies to this skill repository, not consuming projects

## Skill Maintenance

- Keep `SKILL.md` sufficient for common decisions; use `references/` for on-demand detail, not to meet file-size targets
- Revise or merge before adding rules; link shared criteria without triggering full workflows
- Keep project-specific commands, paths, and environment requirements in their owning repositories
- Treat model exercises as interpretation checks, not proof of skill discovery or execution

## Commits

- Use concise Conventional Commit subjects that capture the main changes in behavior or responsibility, not just the editing activity
- Add a brief body when the subject cannot convey important behavior, intent, or boundaries; omit it only when the subject is sufficient. Group related meaning, not implementation details; avoid file lists, diff narration, and repetition. Concise does not mean subject-only; do not require a body or a fixed item count
- Use real newlines and `- ` items, without terminal punctuation or blank lines between items; capitalization is optional
