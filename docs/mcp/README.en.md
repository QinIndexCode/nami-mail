# NamiMail MCP Server

[Chinese](README.md) | [Installation](installation.en.md) | [Configuration](configuration.en.md) | [Tools](tools.en.md) | [Output](output-schema.en.md) | [Security](security.en.md) | [Troubleshooting](troubleshooting.en.md)

> **Current-build status: unavailable.** This Windows build does not ship a verifiable native Windows SID-DACL named-pipe adapter. It therefore starts no external AgentHost or Broker and provides no `namimail` executable, PATH shim, client-pairing UI, or MCP stdio launcher. The MCP configuration, tools, and schema in this document are a future-release security contract; do not add it to a client configuration or attempt to start it in the current build. Experimental local NLLB-200 translation remains separate, explicit, and outside MCP.

NamiMail MCP Server documents how the future interface will let MCP-stdio-capable local developer tools and Agents securely read authorized mail data. It is planned as a paired Broker adapter for the desktop `AgentHost`, not an independent mail service.

## v1 guarantees

- After the native adapter ships, the only transport may be local `stdio -> paired SID-DACL Windows named-pipe Broker`.
- The MCP process never opens SQLite, the mail data directory, a DPAPI master key, or a renderer Fastify token.
- There is no HTTP, Streamable HTTP, TCP, file-URI, or loopback fallback.
- External MCP v1 is read-only. Tool discovery exposes only approved read tools; write and high-risk actions must use one-time confirmation in the visible NamiMail UI.
- Experimental local NLLB-200 translation remains separate and explicit. It is not an MCP tool and MCP startup never processes mail automatically.

## Documentation map

| Document | Contents |
| --- | --- |
| [Installation](installation.en.md) | Current unavailable status and future host, PATH, startup, and pairing prerequisites. |
| [Configuration](configuration.en.md) | Non-pasteable future local MCP-client stdio configuration and version negotiation. |
| [Tools](tools.en.md) | Future v1 read-only tool names, input/output contracts, and permissions. |
| [Output schema](output-schema.en.md) | Future MCP wrappers and stable NamiMail Agent errors. |
| [Resources](resources.en.md) | Why v1 exposes no mail Resources. |
| [Security](security.en.md) | Pairing, scopes, untrusted mail, audit, and privacy. |
| [Examples](examples.en.md) | Typical MCP-client calls. |
| [Troubleshooting](troubleshooting.en.md) | Startup, stdio, pairing, and permission recovery. |

After the native adapter ships, `tools/list` will be the sole authority for host availability and complete JSON Schemas. A client must not infer an unlisted tool from this document, CLI options, or a stale cache.
