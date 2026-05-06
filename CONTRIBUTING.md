# Contributing to AgentBill

Thanks for your interest in contributing. AgentBill is billing infrastructure for AI agents — a preflight gate that blocks runaway runs before they start.

## Before You Begin

- Check [open issues](https://github.com/marketinglior-pixel/agentbill/issues) for something to work on
- Issues labeled [`good first issue`](https://github.com/marketinglior-pixel/agentbill/issues?q=label%3A%22good+first+issue%22) are a great starting point
- For larger changes, open an issue first to discuss the approach

## Prerequisites

- Node.js 20+
- Python 3.10+
- `npm` and `pip`

## Local Dev Setup

**Backend (Node.js / TypeScript):**
```bash
git clone https://github.com/marketinglior-pixel/agentbill.git
cd agentbill
npm install
cp .env.example .env   # fill in your values
npm run dev            # starts on http://localhost:3000
```

**Python SDK:**
```bash
cd sdk/python
pip install -e ".[dev]"
pytest
```

**MCP Server:**
```bash
cd mcp
pip install -e .
uvx agentbill-mcp      # verify it starts
```

## Running Tests

**Smoke test against local server** (requires `npm run dev` running):
```bash
./test_live.sh
```

**Python SDK unit tests:**
```bash
cd sdk/python
pytest
```

## Making a Pull Request

1. Fork the repo and create a branch: `git checkout -b my-fix`
2. Make your changes
3. Run the tests (`./test_live.sh` or `pytest`)
4. Ensure `npm run build` passes (no TypeScript errors)
5. Open a PR with a clear description of what changed and why

## Code Style

- **TypeScript:** follow the existing Fastify patterns in `src/`; no need for strict formatting enforcement yet
- **Python:** PEP 8; use type hints where the rest of the file does
- **Commits:** short imperative messages (`add preflight timeout`, `fix record endpoint 404`)

## Questions?

Open an issue or reach out at marketinglior@gmail.com.
