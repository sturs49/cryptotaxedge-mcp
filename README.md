# CryptoTaxEdge MCP Server

**US tax classification for on-chain transactions, as an MCP server.** Submit transaction
hashes and get back the canonical event category, the US tax treatment with cited
authority, a calibrated confidence score, an explicit route-to-review flag on uncertain
rows, and per-leg breakdowns with counterparty identification. 80+ chains, including
Ethereum, the major L2s, and Solana.

This is a **remote** MCP server — nothing to install or run locally.

- **Endpoint:** `https://mcp.cryptotaxedge.com/` (streamable HTTP, JSON-RPC 2.0)
- **Auth:** `Authorization: Bearer YOUR_API_KEY` — free self-serve Developer key
  (no card) at [dashboard.cryptotaxedge.com](https://dashboard.cryptotaxedge.com)
  under Settings → API Keys
- **Docs:** [dashboard.cryptotaxedge.com/api](https://dashboard.cryptotaxedge.com/api)
- **Site:** [cryptotaxedge.com](https://cryptotaxedge.com)

## What it returns

Every classification carries the reliability envelope:

| Field | Meaning |
|---|---|
| `category` | Canonical event type (swap, liquidity_add, reward, bridge, ...) |
| `treatment` | Closed enum: `disposal`, `income`, `non_taxable`, `expense`, `needs_review` |
| `taxable` | `true`, `false`, or `null` — `null` always travels with `needs_review: true` |
| `confidence` | Routing signal: how strongly independent evidence agreed |
| `needs_review` | The honesty contract — uncertain rows are flagged, never guessed |
| `grey_area` | On contested treatments (LP, wrap, liquid staking): the position not taken |
| `assets` | Per-leg sent/received breakdown with counterparties |

Plain transfers, approvals, spam, failed and unsupported transactions, and every repeat
come back fully identified at no charge.

## Try it

List the tools:

```bash
curl -X POST https://mcp.cryptotaxedge.com/ \
  -H "Authorization: Bearer $CTE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Classify a batch (up to 100 per call):

```bash
curl -X POST https://mcp.cryptotaxedge.com/ \
  -H "Authorization: Bearer $CTE_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"classify_batch","arguments":{"transactions":[{"tx_id":"row_1","tx_hash":"0x...","chain":"ethereum"}]}}}'
```

The same engine is available over plain REST — see the
[API docs](https://dashboard.cryptotaxedge.com/api) and the
[developer quickstart](https://cryptotaxedge.com/blog/get-tax-treatment-of-transaction-programmatically).

## Registry manifest

[`server.json`](./server.json) — published to the official
[MCP Registry](https://github.com/modelcontextprotocol/registry) as
`io.github.sturs49/cryptotaxedge`.

## Cite / provenance

The category vocabulary and treatment semantics this server returns are the
[CryptoTaxEdge Classification Standard](https://cryptotaxedge.com/standard/):
an open, versioned schema with worked examples and tax-position caveats,
licensed CC BY 4.0. The standard and the 2026 H1 labelled benchmark corpus
(388 public transaction hashes) are archived at DOI
[10.5281/zenodo.21911546](https://doi.org/10.5281/zenodo.21911546) and
mirrored as a Hugging Face dataset:
[CryptoTaxEdge/crypto-tax-classification-2026h1](https://huggingface.co/datasets/CryptoTaxEdge/crypto-tax-classification-2026h1).

- Methodology and benchmark notes: [cryptotaxedge.com/research](https://cryptotaxedge.com/research/)
- Verbatim request/response captures, replayed nightly against the live engine:
  [sturs49/cryptotaxedge-examples](https://github.com/sturs49/cryptotaxedge-examples)

---

Classifications are informational only, not tax advice. Verify results with a qualified
tax professional before filing.
