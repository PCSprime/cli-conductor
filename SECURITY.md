# Security Policy

## Design

CLI Conductor is meant to run on your own machine for your own use:

- The server listens on **127.0.0.1 only**. It is not meant to be exposed to a network; do not put it behind a reverse proxy or port forward.
- Requests with a foreign `Host` or `Origin` header are rejected (protects against DNS rebinding and cross-site requests from web pages).
- Every non-GET API call needs the header `x-cli-conductor: 1`, which browsers cannot send cross-origin without a CORS preflight the server never grants.
- The app starts the CLIs you configured, with the arguments shown in the *Final command* preview. Anyone who can reach the server can type into those terminals, which is why it is local-only.
- No telemetry. The app makes no network requests of its own; each CLI keeps its own network behaviour and credentials.
- Account folders are created under `%USERPROFILE%\.cli-conductor\accounts`; the app never reads or changes the CLIs' default homes.

Note that "Skip all confirmations" / full-auto modes let an AI CLI run commands without asking. Use them only in workspaces you can afford to lose.

## Supported versions

Only the latest release gets security fixes.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's *Report a vulnerability* (private vulnerability reporting) on this repository. We aim to reply within 7 days.
