Read-only message list for the role-play acceptance mode.

The script reads one OpenProject project through its MCP endpoint, runs QM's reader, reminder rules, change digest and role-play output over what it reads, and writes every message that would be sent to a Markdown file. It posts nothing anywhere and writes nothing to OpenProject.

Runtime: Node 22 or newer (tested on 24.22.1). No install step, no dependencies.

Run:

    NODE_EXTRA_CA_CERTS=ca.crt ZQ_TEST_TOKEN=<personal OAuth token> node zq-roleplay-report.mjs \
      --mcp https://10.0.2.39:18765/mcp --projects 14 --jelly-op-user 169 \
      --contract zq-contract-keys.json --out messages.md --state state.json

- `ZQ_TEST_TOKEN` is read from the environment and is never written to disk or printed. Do not put it on the command line.
- `NODE_EXTRA_CA_CERTS` points to the CA file of the OpenProject test endpoint.
- `--state` keeps what was already reported. Run again after changing tickets to see only what is new; delete the file to start over.
- `--out` is the message list. Each message starts with three lines: the role being played, who it was meant for, and the rule that triggered it.
- Failures of the daily and weekly reports are logged to the console and do not appear in the list.

The completion property is read from `delivery_result`; the order counts as submitted when it is `pass` or `true`.
