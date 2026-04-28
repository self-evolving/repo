# Deployment

This section focuses on the two main operational choices behind the `.agent` backend:

1. **How GitHub authentication is resolved**
   - [Setup guide](setup-guide.md) for full details
   - [Install into an existing repository](install-existing-repository.md) for the minimal non-template path
   - [Using your own GitHub App](using-your-own-github-app.md) for the supported self-managed auth path
2. **Where the workflows run**
   - GitHub-hosted runners
   - Use [self-hosted GitHub Action runner](self-hosted-github-action-runner.md) for faster execution and more control over the environment
