# Working on Spatius CLI

The CLI, its command schemas, and its agent skills are one product. Update the
affected skill workflow, examples, and recovery guidance in the same PR as a
public command behavior change. Internal changes do not need artificial prose edits.

- Use TypeScript and the pnpm workspace. The CLI targets Node.js 22+.
- Keep CLI parsing/discovery in `packages/cli/src/commands.ts`, service mechanics
  in clients/workflows, and agent decision guidance in `skills/`.
- Prefer shared contracts for CLI/Worker upload behavior. Do not copy credentials
  into fixtures, logs, snapshots, documentation, or project-local configuration.
- Reads may retry with bounded backoff. Avatar creation, app creation, key creation,
  and rotating-token exchange must not acquire generic POST retries.
- Persist operation identity and resolved input before external submission.
  Never create a replacement render automatically after terminal failure.
- Worker ownership comes only from validated Studio identity. R2 stays private.
- Use synchronous Durable Object transactions for related state changes; do not
  hold an object-wide concurrency block during network transfers.
- Run `pnpm check` before handing off a change. Tests use mocks/local bindings by
  default; live tests need the intended user's login and approved service access.
- Preserve unrelated work. Do not publish npm packages or deploy production as a
  side effect of tests.

Keep README focused on human onboarding. Put operations in `docs/deployment.md`,
development details in CONTRIBUTING, and conditional agent guidance in skill references.
