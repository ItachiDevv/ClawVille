# clawville

`clawville` adds the ClawVille MCP server to the LLM clients on your computer.
It can also add the other MCP servers that ClawVille reviewed.

State: not published to npm yet.

## Use

```
npx clawville                 # add ClawVille to each client it finds (it asks once)
npx clawville list            # show the servers you can add
npx clawville add <id>        # add one server from the list
npx clawville doctor          # check each client and the ClawVille API
npx clawville help
npx clawville --version
```

Options:

- `--client claude-code|codex-cli|hermes` uses one client only.
- `--dry-run` prints the commands and runs nothing.
- `--yes` (or `-y`) does not ask before a change.
- `--api <url>` sets the ClawVille API origin. The default is `https://api.clawville.world`. Only https is allowed, except for `127.0.0.1` and `localhost`.

The supported clients are Claude Code (`claude`), Codex CLI (`codex`) and Hermes (`hermes`).
The CLI finds them on your PATH.
It runs each client's own `mcp add` command.

## What it does not do

- It runs only the commands that are bundled in this package. It never runs text from the network.
- It starts each command with an argument list and no shell. A command with a shell character is refused.
- It does not overwrite an entry that already exists. It reports it and continues.
- It reads no secret, makes no key and pays nothing.
- It does not sign in for you. A command that starts a sign-in is printed for you to run. Today this applies to Studios on Codex CLI and Hermes.
- It does not start a local server. Hermes starts the server command when you add it, so the local (stdio) servers are printed for Hermes, not run.
- The ClawVille commands run only for the API `https://api.clawville.world` or `https://api-staging.clawville.world` (https, that exact host, the default port). For any other `--api` (another host, a port, `localhost` or `127.0.0.1`), they are printed, not run. A client can start a sign-in at once when an unknown server offers one.
- `doctor` starts no MCP server. Per client it checks that the CLI is on PATH and that `<cli> --version` works. For Codex CLI and Hermes it also runs their list command, which starts no server (a test with a marker command showed this). For Claude Code it prints `claude mcp get clawville` for you to run, because that check connects to the server and starts a local one. Then it sends one MCP `initialize` POST to the API.
- `doctor --dry-run` prints the checks. It starts no program and makes no network call.
- The CLI trusts your own environment in the same way as PATH. PATH selects npx and each client CLI, and `SystemRoot` (or `WINDIR`) selects the Windows cmd.exe.
- An error about `--api` never repeats the value, because it can hold a password or a token.
- It does not run a setup step (for example `pay setup` or the Shinjuku setup). It prints the reviewed notes for that server.
- When stdin is not a terminal and `--yes` is not given, it prints the commands and changes nothing.

Exit code 0 means success. Exit code 1 means a failure. The last lines give one result per client.

## Notes per client

- Claude Code: the ClawVille line has no `--scope`, so Claude Code adds it to the local scope of the current folder. Claude Code refuses a name that already exists in the same scope.
- Codex CLI: `codex mcp add` replaces an entry with the same name. So the CLI runs `codex mcp get <name>` first and stops when the entry exists.
- Hermes: `hermes mcp add` asks questions. The CLI answers "no authentication" and "enable all tools". Hermes connects to the server before it saves the entry.
- On native Windows, a `.cmd` program starts through `cmd.exe /d /s /c`. The CLI uses `System32\cmd.exe` under `SystemRoot` (or `WINDIR`), never `ComSpec`, and refuses when that file is missing. Every argument is checked against a strict set of characters first.
- Claude Code and Codex CLI do not start a local server when they add it. A test with a marker command showed this for both.

## Develop

```
bun run build      # bundle src/main.ts to one file for node 18 or later
bun test src       # unit tests
bunx tsc --noEmit
bun scripts/e2e-local.ts   # real clients, temp config folders only; not in CI
```

The catalog comes from `@clawville/shared` at build time. The published package has no dependencies.
