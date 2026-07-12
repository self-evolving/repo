<p align="center">
  <img src=".github/assets/sepo-headline.png" alt="Sepo — the self-evolving repo" width="575" />
</p>

<p align="center">
  <a href="https://docs.sepo.sh/tutorials/">Quick start</a> &nbsp;|&nbsp;
  <a href="https://docs.sepo.sh">Documentation</a> &nbsp;|&nbsp;
  <a href="https://sepo.sh">Website</a> &nbsp;|&nbsp;
  <a href="https://app.sepo.sh">Try Sepo</a>
</p>

---

**Sepo** turns a GitHub repository into a **self-evolving repository**: mention `@sepo-agent` in issues, PRs, and discussions, and agent work happens where your team already collaborates — traceable in PRs, guarded by review, and feeding repository-owned memory that improves the next run.

- **Work in place** — `@sepo-agent` answers questions, implements issues, reviews PRs, and fixes branches right from GitHub comments; runs execute in GitHub Actions with live progress and cancel control.
- **The repo learns** — sessions persist on the `agent/memory` branch, and lessons from your discussions and reviews become `agent/rubrics` that steer future runs.
- **Own the long horizon** — `/orchestrate` keeps bounded implement → review → fix loops moving until review passes, and scheduled jobs let the repo improve itself under your supervision.

**Get started →** create a repository with **Use this template** and install the [Sepo GitHub App](https://github.com/apps/sepo-agent-app/installations/select_target), then follow the [quick start](.agent/docs/overview/quick-start.md) — or [install Sepo into an existing repository](.agent/docs/setup/install-existing-repository.md).

The full documentation lives in [`.agent/docs`](.agent/docs/index.md) and is published at [docs.sepo.sh](https://docs.sepo.sh).

## License

Licensed under the [MIT License](LICENSE).
