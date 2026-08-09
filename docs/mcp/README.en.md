# NamiMail MCP Server

[Chinese](README.zh-CN.md) | [Installation](installation.en.md) | [Configuration](configuration.en.md) | [Tools](tools.en.md) | [Output](output-schema.en.md) | [Security](security.en.md) | [Troubleshooting](troubleshooting.en.md)

> **Current-build status: available.** The 0.3.0 installer ships a managed `namimail` command and PATH shim, and the desktop main process runs a paired SID-DACL named-pipe Broker that routes MCP stdio sessions. The installer smoke test starts `namimail mcp start` through `cmd.exe`, performs MCP initialization, and verifies that `tools/list` returns exactly fifteen tools (eight read-only plus seven write tools with matching annotations). Data tools require a running, paired Agent host. Experimental local NLLB-200 translation remains separate, explicit, and outside MCP.

NamiMail MCP Server documents how MCP-stdio-capable local developer tools and Agents securely read authorized mail data. It is a paired Broker adapter for the desktop `AgentHost`, not an independent mail service.

## v1 guarantees

- The only transport is local `stdio -> paired SID-DACL Windows named-pipe Broker`.
- The MCP process never opens SQLite, the mail data directory, a DPAPI master key, or a renderer Fastify token.
- There is no HTTP, Streamable HTTP, TCP, file-URI, or loopback fallback.
- External MCP access level defaults to `read-only` and can be configured independently in the desktop app as one of three levels (`read-only` / `send-confirmed` / `full-access`). Write actions at `send-confirmed` use visible one-time confirmation in the NamiMail UI; `full-access` executes automatically within approved account scope. See [Security](security.en.md) and [Tools](tools.en.md).
- Experimental local NLLB-200 translation remains separate and explicit. It is not an MCP tool and MCP startup never processes mail automatically.

## Documentation map

| Document | Contents |
| --- | --- |
| [Installation](installation.en.md) | Installer prerequisites: host, PATH, startup, and pairing. |
| [Configuration](configuration.en.md) | Pasteable local MCP-client stdio configuration and version negotiation. |
| [Tools](tools.en.md) | v1 tool names (read-only + write), input/output contracts, and permissions. |
| [Output schema](output-schema.en.md) | MCP wrappers and stable NamiMail Agent errors. |
| [Resources](resources.en.md) | Why v1 exposes no mail Resources. |
| [Security](security.en.md) | Pairing, scopes, untrusted mail, audit, and privacy. |
| [Examples](examples.en.md) | Typical MCP-client calls. |
| [Troubleshooting](troubleshooting.en.md) | Startup, stdio, pairing, and permission recovery. |

`tools/list` is the sole authority for host availability and complete JSON Schemas. A client must not infer an unlisted tool from this document, CLI options, or a stale cache.
