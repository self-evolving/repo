<p align="center">
  <img src=".github/assets/sepo-headline.png" alt="Sepo — the self-evolving repo" width="575" />
</p>

<p align="center">
  <a href="https://app.sepo.sh/new">Create a Sepo</a> &nbsp;|&nbsp;
  <a href="https://sepo.sh/#tour">Quick guide</a> &nbsp;|&nbsp;
  <a href="https://sepo.sh">Learn more</a> &nbsp;|&nbsp;
  <a href="https://github.com/apps/sepo-agent-app/installations/select_target">Install the Sepo App</a>
</p>

---

The goal of a self-evolving repo (**Sepo**) is to make a workspace for **structured team–agent collaboration**, such that (1) it can streamline the coding work and session management, (2) the agent can grow and share the project memory / rubrics with you and the team, and (3) ultimately the agent will become the **"owner" of the repo** and can self-improve and evolve the code. Concretely:

1. **At the interaction level**, Sepo allows you to mention `@sepo-agent` anywhere on GitHub and it answers, implements, reviews, and fixes your code. Every exchange lands as structured work — issues, PRs, and comments you can reference, search, and share across team members.
2. **Through the collaboration**, the agent grows with you: the agent memorizes project context, extracts your rubrics, and saves them in the [`agent/memory`](https://docs.sepo.sh/sepo/architecture/memory) and [`agent/rubrics`](https://docs.sepo.sh/sepo/architecture/rubrics) branches.
3. **In the longer term**, Sepo can take over longer jobs, handle [project goals](https://docs.sepo.sh/sepo/architecture/goals), and self-improve.

## See Sepo in practice

- **Live literature**: see how Sepo live-updates and creates an [evolving literature](https://literature-example-hcllms.vercel.app) — readers can ask questions right on the site ([repo](https://github.com/self-evolving/literature-example-hcllms))
- **Managing websites**: we use Sepo to manage the [Augmented Mind website](https://augmented-mind.github.io) with seamless team–AI collaboration ([repo](https://github.com/augmented-mind/augmented-mind.github.io))
- **Supporting math proving**: built on Sepo, [Lean Workspace](https://lean-workspace.sepo.site/) streamlines team–AI collaboration for writing proofs ([template](https://github.com/self-evolving/lean-workspace-template))
- **Handling long-running repo-level auto-research**: using Sepo to continuously improve a repo for a goal (coming soon)
