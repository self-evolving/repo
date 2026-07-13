<p align="center">
  <img src=".github/assets/sepo-headline.png" alt="Sepo — the self-evolving repo" width="575" />
</p>

<p align="center">
  <a href="https://app.sepo.sh/new">Install Sepo</a> &nbsp;|&nbsp;
  <a href="https://sepo.sh/#tour">Quick guide</a> &nbsp;|&nbsp;
  <a href="https://sepo.sh">Learn more</a>
</p>

---

The goal of a self-evolving repo is to make a workspace for structured team–agent collaboration, such that (1) it can streamline the coding work and session management, (2) the agent can share the project memory / rubrics with you and the team and grow, and (3) ultimately the agent will become the "owner" of the repo and can self-improve and evolve the code. Concretely:

1. At the interaction level, Sepo allows you to mention `@sepo-agent` anywhere on GitHub and it answers, implements, reviews, and fixes your code. Every exchange lands as structured work — issues, PRs, and comments you can reference, search, and share across team members.
2. Through the collaboration, the agent grows with you: the agent memorizes project context, extracts your rubrics, and saves them in the [`agent/memory`](https://docs.sepo.sh/sepo/architecture/memory) and [`agent/rubrics`](https://docs.sepo.sh/sepo/architecture/rubrics) branches.
3. In the longer term, Sepo can take over longer jobs, handle [project goals](https://docs.sepo.sh/sepo/architecture/goals), and self-improve.

**Get started →** [install Sepo](https://app.sepo.sh/new) on a new or existing repository, then follow the [quick start](.agent/docs/overview/quick-start.md).

The full documentation lives in [`.agent/docs`](.agent/docs/index.md) and is published at [docs.sepo.sh](https://docs.sepo.sh).

> [!TIP]
> Starting a project from this template? This README is yours — replace it with your project's own. Sepo's documentation and tooling live under [`.agent/`](.agent/README.md), and Sepo's update workflow never touches your root README.

## License

Licensed under the [MIT License](LICENSE).
