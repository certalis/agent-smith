# ccflare Documentation

> [!WARNING]
> These docs describe **agent-smith, a proof of concept for ideation, not a
> product**. No warranty, no support. Claude Code and Codex subscription
> sign-ins are off by default; read the README's
> [provider terms section](../README.md#subscription-sign-ins-and-provider-terms)
> before enabling one. Marketing-style wording below (such as "never hit rate
> limits") is inherited from the upstream ccflare project and is not a promise or
> a recommendation.

## Track Every Request. Go Low-Level. Never Hit Rate Limits Again.

![Build Status](https://img.shields.io/badge/build-passing-brightgreen)
![Version](https://img.shields.io/badge/version-1.0.0-blue)
![License](https://img.shields.io/badge/license-MIT-green)
![Bun](https://img.shields.io/badge/bun-%3E%3D1.2.8-f472b6)

## Overview

ccflare is the ultimate Claude API proxy with intelligent load balancing across multiple accounts. Built with TypeScript and Bun runtime, it provides full visibility into every request, response, and rate limit, ensuring your AI applications never experience downtime due to rate limiting.

### Why ccflare?

When working with Claude API at scale, rate limits can become a significant bottleneck. ccflare solves this by:

- **🚀 Zero Rate Limit Errors**: Automatically distributes requests across multiple accounts with intelligent failover
- **📊 Request-Level Analytics**: Track latency, token usage, and costs in real-time with <10ms overhead
- **🔍 Deep Debugging**: Full request/response logging and error traces for complete visibility
- **💸 Quota-Aware Routing**: Keeps eligible work on its account and makes bounded failover decisions from current quota state
- **⚡ Production Ready**: Built for scale with SQLite persistence, OAuth token refresh, and configurable retry logic

## Key Features

### 🎯 Intelligent Load Balancing
- **Quota-aware account choice**: Uses current quota windows, account priority, model-family eligibility, and bounded failover
- **⚠️ Bounded retries**: A failure can use one eligible sibling; it never walks the fleet

### 📈 Real-Time Monitoring & Analytics
- **Web Dashboard**: Interactive UI at the server root (`/`) with live metrics
- **Terminal UI**: Built-in TUI for server management and monitoring
- **Request Tracking**: Complete history with token usage and costs
- **Performance Metrics**: Response times, success rates, and error tracking

### 🛠️ Developer Experience
- **Zero Config Proxy**: Drop-in replacement for Claude API
- **CLI Management**: Add, remove, and manage accounts easily
- **Automatic Failover**: Seamless switching on rate limits
- **OAuth Token Refresh**: Handles authentication automatically

### 🏗️ Production Ready
- **SQLite Persistence**: Reliable data storage with migrations
- **Configurable Retry Logic**: Smart exponential backoff
- **Extensible Architecture**: Provider-based design for future AI services

## Documentation

### Getting Started
- [Configuration Guide](./configuration.md) - Environment variables and configuration options
- [Architecture Overview](./architecture.md) - System components and design principles
- [Data Flow](./data-flow.md) - Request lifecycle through the system

### Core Features
- [Load Balancing Strategy](./load-balancing.md) - Quota-aware account choice and safe failover
- [Provider System](./providers.md) - Provider abstraction and OAuth implementation
- [Database Schema](./database.md) - SQLite structure, migrations, and maintenance

### User Interfaces
- [HTTP API Reference](./api-http.md) - Complete REST API documentation
- [CLI Commands](./cli.md) - Command-line interface reference
- [Terminal UI Guide](./tui.md) - Interactive terminal interface documentation

### Operations
- [Deployment Guide](./deployment.md) - Production deployment with Docker, systemd, PM2, and Kubernetes
- [Private Network Guide](./private-network.md) - WireGuard deployment for one private shared pool
- [Security Considerations](./security.md) - Authentication, encryption, and best practices
- [Troubleshooting](./troubleshooting.md) - Common issues and solutions
- [Contributing](./contributing.md) - Development setup and contribution guidelines

## Quick Start

### 1. Install ccflare

```bash
# Clone the repository
git clone https://github.com/snipeship/ccflare.git
cd ccflare

# Install dependencies
bun install
```

### 2. Start ccflare (TUI + Server)

```bash
# Start ccflare with interactive TUI (automatically starts server)
bun run ccflare

# Or start just the server without TUI
bun run server

# The quota-aware kernel chooses from eligible accounts automatically.
# Configure a proxy key before serving client traffic.
CF_PROXY_KEY=replace-with-a-secret bun run server

# Run TUI directly with Bun (if not using npm scripts)
bun run apps/tui/src/main.ts
```

### 3. Add Your Claude Accounts

```bash
# In another terminal, add your accounts
# Add a work account
bun run apps/tui/src/main.ts --add-account work-account

# Add a personal account  
bun run apps/tui/src/main.ts --add-account personal-account

# Add Anthropic and OpenAI API key accounts
bun run apps/tui/src/main.ts --add-account work-account --provider anthropic
bun run apps/tui/src/main.ts --add-account personal-account --provider openai

# Start provider-scoped OAuth flows
bun run apps/tui/src/main.ts --add-account claude-work --provider claude-code
bun run apps/tui/src/main.ts --add-account codex-work --provider codex

# Or if you have ccflare command available globally
ccflare --add-account work-account
```

### 4. Configure Your Claude Client

```bash
# Set the base URL to use ccflare
export ANTHROPIC_BASE_URL=http://localhost:8080
```

### 5. Monitor Your Usage

- **Web Dashboard**: Open [http://localhost:8080](http://localhost:8080) for real-time analytics
- **Terminal UI**: Use the interactive TUI started with `bun run ccflare`
- **CLI**: Check status with `bun run apps/tui/src/main.ts --list`

## Project Structure

```
ccflare/
├── apps/               # Application packages
│   ├── server/        # Main proxy server
│   ├── tui/           # Terminal UI with integrated CLI
│   └── web/           # Browser dashboard
├── packages/          # Shared packages
│   ├── api/           # REST API handlers
│   ├── config/        # Configuration management
│   ├── core/          # Core utilities, lifecycle, DI, pricing
│   ├── database/      # SQLite database layer
│   ├── http/          # Shared HTTP utilities and HTTP errors
│   ├── logger/        # Logging utilities
│   ├── oauth-flow/    # OAuth account onboarding
│   ├── providers/     # Provider implementations
│   ├── proxy/         # HTTP/WebSocket proxy implementation
│   ├── runtime-server # Server bootstrap/runtime composition
│   ├── types/         # Shared types and guards
│   └── ui/            # Shared UI presenters, components, constants
└── docs/              # Documentation

```

## Scripts Reference

```bash
# Main commands
bun run ccflare        # Start TUI (builds dashboard first)
bun run server         # Start server only
bun run tui            # Start TUI only
bun run start          # Alias for bun run server

# Development
bun run dev            # Start TUI in development mode
bun run dev:server     # Server with hot reload
bun run dev:dashboard  # Dashboard development

# Build & Quality
bun run build          # Build dashboard and TUI
bun run build:dashboard # Build web dashboard
bun run build:tui      # Build TUI
bun run typecheck      # Check TypeScript types
bun run lint           # Fix linting issues
bun run format         # Format code
```

## CLI Commands

The ccflare CLI is integrated into the TUI application. All CLI functionality is accessed through the same executable:

```bash
# If running without global install, use the full path:
bun run apps/tui/src/main.ts [command]

# The commands below assume you're using the full path

# Account management
bun run apps/tui/src/main.ts --add-account <name>     # Add account
bun run apps/tui/src/main.ts --list                   # List accounts
bun run apps/tui/src/main.ts --remove <name>          # Remove account
bun run apps/tui/src/main.ts --pause <name>           # Pause account
bun run apps/tui/src/main.ts --resume <name>          # Resume account

# Maintenance
bun run apps/tui/src/main.ts --reset-stats            # Reset statistics
bun run apps/tui/src/main.ts --clear-history          # Clear request history
bun run apps/tui/src/main.ts --analyze                # Analyze database performance

# Other options
bun run apps/tui/src/main.ts --serve                  # Start server only
bun run apps/tui/src/main.ts --logs [N]               # Stream logs (optionally show last N lines)
bun run apps/tui/src/main.ts --stats                  # Show statistics (JSON)
bun run apps/tui/src/main.ts --help                   # Show help

# Add account
bun run apps/tui/src/main.ts --add-account <name> --provider <anthropic|openai|claude-code|codex>
```

For more detailed CLI documentation, see [CLI Commands](./cli.md).

## Environment Variables

```bash
# Server Configuration
PORT=8080                        # Server port (default: 8080)
CF_PROXY_KEY=replace-with-a-secret # Required client credential
# LB_STRATEGY and SESSION_DURATION_MS are legacy session-strategy settings.
# They do not control the quota-aware proxy kernel.

# OAuth Configuration
CLIENT_ID=<your-client-id>      # Custom OAuth client ID (optional)

# Retry Configuration
RETRY_ATTEMPTS=3                # Number of retry attempts (default: 3)
RETRY_DELAY_MS=1000            # Initial retry delay in ms (default: 1000)
RETRY_BACKOFF=2                # Exponential backoff multiplier (default: 2)

# Development
LOG_LEVEL=info                  # Logging level (debug|info|warn|error)
NODE_ENV=production            # Environment mode
```

## Related Resources

### External Links
- [Claude API Documentation](https://docs.anthropic.com/claude/docs) - Official Anthropic API docs
- [Bun Documentation](https://bun.sh/docs) - Bun runtime documentation
- [SQLite Documentation](https://www.sqlite.org/docs.html) - SQLite database docs

### Support
- [GitHub Repository](https://github.com/snipeship/ccflare) - Source code and issues
- [Contributing](./contributing.md) - How to contribute to ccflare

## License

ccflare is open source software licensed under the MIT License. See the [LICENSE](../LICENSE) file for details.

---

<div align="center">
  <p>Built with ❤️ for developers who ship</p>
  <p>
    <a href="#quick-start">Get Started</a> •
    <a href="./architecture.md">Learn More</a> •
    <a href="./contributing.md">Contribute</a>
  </p>
</div>
