# bettercss

Hard ground truth for CSS. Extracts the browser's actual layout — positions,
boxes, cascade — as deterministic, diffable text, so coding agents stop
guessing what rendered.

## Install

    npm install && npm run build

Requires Chrome. Attaches to a running Chrome at port 9222, else launches headless.

## MCP (live agent loop)

Add to `.mcp.json`:

```json
{
  "mcpServers": {
    "bettercss": { "command": "node", "args": ["/path/to/better_css/dist/mcp.js"] }
  }
}
```

Tools: `layout`, `inspect`, `explain`, `check`, `snapshot`, `diff`.

Note: `snapshot` and `diff` resolve a relative `dir` (default `.bettercss`)
against the MCP server's working directory, which the host fixes at launch.
When in doubt — e.g. one global `.mcp.json` shared across repos — pass an
absolute `dir` argument, or register the server per-project in that project's
`.mcp.json`.

## CLI (CI / scripts)

    npx bettercss check http://localhost:3000            # invariants, exit 1 on violations
    npx bettercss layout http://localhost:3000           # the layout tree (budgeted to 400 lines unless --depth is given)
    npx bettercss explain http://localhost:3000 --selector .sidebar --property width
    npx bettercss snapshot http://localhost:3000 --name home
    npx bettercss diff http://localhost:3000 --name home

## Escape hatch

`data-bettercss-ignore` on an element skips it in all invariant checks.
