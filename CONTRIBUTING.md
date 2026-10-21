# Contributing to CLI Conductor

Thanks for helping! Bug reports, adapter fixes for new CLI versions, translations and features are all welcome.

## Development setup

- Windows 10 1809+ / 11, Node.js 20+.
- `npm install`, then `npm start` (http://127.0.0.1:7430). Use `CC_PORT` and `CC_DATA_DIR` to run a dev instance next to your normal one.
- No build step: the frontend is plain scripts in `public/` (`i18n.js`, `stage.js`, `app.js`), the server is `server.js` plus `lib/`.

## Tests

Run each file on its own (this is what CI does):

```powershell
node --test test/unit.test.js
node --test test/ui.test.js
node --test test/accounts.test.js
node --test test/restart.test.js
node --test test/send-script.test.js
node --test test/integration.test.js
```

Tests never start a real AI CLI; they use `test/fake-cli.js` in a real ConPTY. Please add or update tests with your change.

## Guidelines

- Keep the server local-only: listen on 127.0.0.1, keep the Host/Origin checks and the `x-cli-conductor` header on write calls.
- New launch flags (`lib/cliflags.js`) must come from the CLI's official docs or `--help`; note the source in the PR.
- Every user-facing string goes through `t()` and needs a Simplified Chinese entry in `public/i18n.js`.
- Never write into a CLI's default home (`~/.codex`, `~/.claude`, …); accounts live in their own folders.
- Small, focused PRs with a clear description and screenshots for UI changes. Don't include personal paths or data in screenshots.

## Reporting bugs

Use the bug report template. Include your Windows and Node versions, the CLI and its version, and the relevant lines of `<workspace>\.tmp\cli_conductor\events.jsonl` (remove anything private).

By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
