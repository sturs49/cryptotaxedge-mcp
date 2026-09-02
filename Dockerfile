# Listing-repo catalog proxy for Glama (and local) introspection.
# This is not the CryptoTaxEdge classification engine — it forwards MCP
# initialize / tools/list / ping to https://mcp.cryptotaxedge.com/.
#
# Listen port: 8080 (override with PORT). Bind 0.0.0.0.
#   docker build -t cryptotaxedge-mcp .
#   docker run --rm -p 8080:8080 cryptotaxedge-mcp
#
# Glama's generated Dockerfile wraps CMD with `mcp-proxy --`. If you fill the
# admin form instead of using this file, set CMD to:
#   ["node", "server.mjs", "--stdio"]

FROM node:22-alpine

WORKDIR /app
COPY package.json server.mjs ./

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0

USER node
EXPOSE 8080

CMD ["node", "server.mjs"]
