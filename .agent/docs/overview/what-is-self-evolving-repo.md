# What is a self-evolving repository?

Besides the code itself, a self-evolving repository also contains two things: a schema for organizing development context, and an operational layer that can act on that context.

## 1. A schema for development artifacts

Traditional repositories are good at storing source code, configuration, and build scripts. A self-evolving repository also needs a place and a pattern for artifacts that matter during agent-assisted development, such as:

- memories and interaction histories
- user preferences and operating conventions
- plans, evaluations, and verification traces
- prompts, skills, and other reusable agent-facing assets

In that sense, it plays a role similar to tools like `just`, `make`, or `cmake`: it helps organize how development work happens, not just what files exist. For agent development, this matters even more because traceability, reproducibility, and efficiency depend on preserving context in a structured and inspectable way.

## 2. A way to run and collaborate with agents

A self-evolving repository also needs a way to actually launch agents and work with them. In this repository, that means using GitHub-native surfaces such as:

- mentions in issues, pull requests, and discussions
- labels and approval commands
- reusable workflows and route-specific prompts

That operational layer lets the repository answer questions, propose changes, review pull requests, fix issues, and improve its own workflow over time.

## From static artifact to living system

The point is not that code becomes magical. The point is that the repository is no longer treated as only a static artifact. It becomes a living system that can accumulate context, respond to feedback, and evolve alongside development.
