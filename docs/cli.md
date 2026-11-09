# agent-smith CLI Documentation

The agent-smith CLI provides a command-line interface for managing OAuth accounts, monitoring usage statistics, and controlling the load balancer.

## Table of Contents

- [Installation and Setup](#installation-and-setup)
- [Global Options and Help](#global-options-and-help)
- [Command Reference](#command-reference)
  - [Account Management](#account-management)
  - [Statistics and History](#statistics-and-history)
  - [System Commands](#system-commands)
  - [Server and Monitoring](#server-and-monitoring)
- [Usage Examples](#usage-examples)
- [Configuration](#configuration)
- [Environment Variables](#environment-variables)
- [Troubleshooting](#troubleshooting)

## Installation and Setup

### Prerequisites

- Bun runtime (>= 1.2.8)
- Node.js compatible system

### Installation

1. Clone the repository:
```bash
git clone https://github.com/snipe-code/agent-smith.git
cd agent-smith
```

2. Install dependencies:
```bash
bun install
```

3. Build the CLI:
```bash
bun run build
```

4. Run the CLI:
```bash
agent-smith [options]
```

### First-time Setup

1. Add your first OAuth account:
```bash
agent-smith --add-account myaccount
```

2. Start the load balancer server:
```bash
agent-smith --serve
```

## Global Options and Help

### Getting Help

Display all available commands and options:

```bash
agent-smith --help
```

Or use the short form:

```bash
agent-smith -h
```

### Help Output Format

```
🎯 agent-smith - Multi-provider Load Balancer

Usage: agent-smith [options]

Options:
  --serve              Start API server with dashboard
  --port <number>      Server port (default: 8080, or PORT env var)
  --logs [N]           Stream latest N lines then follow
  --stats              Show statistics (JSON output)
  --add-account <name> Add a new account
    --provider <anthropic|openai|claude-code|codex>  Account provider (required)
  --list               List all accounts
  --remove <name>      Remove an account
  --pause <name>       Pause an account
  --resume <name>      Resume an account
  --analyze            Analyze database performance
  --reset-stats        Reset usage statistics
  --clear-history      Clear request history
  --help, -h           Show this help message

Interactive Mode:
  agent-smith          Launch interactive TUI (default)
```

## Command Reference

### Account Management

#### `--add-account <name>`

Add a new account to the load balancer pool.

**Syntax:**
```bash
agent-smith --add-account <name> --provider <anthropic|openai|claude-code|codex>
```

**Options:**
- `--provider`: Target provider. API-key providers prompt for a key; OAuth providers start a browser flow.

**Interactive Flow:**
1. Validates the provider
2. For API-key providers, prompts for the API key
3. For OAuth providers, opens a browser to start the OAuth flow
4. Exchanges the returned authorization code for tokens
5. Stores the account credentials in the database

#### `--list`

Display all configured accounts with their current status.

**Syntax:**
```bash
agent-smith --list
```

**Output Format:**
```
Accounts:
  Name                Provider      Auth Method   Weight  Status
  work-account        anthropic     api_key       1       ok
  claude-work         claude-code   oauth         1       ok
```

#### `--remove <name>`

Remove an account from the configuration.

**Syntax:**
```bash
agent-smith --remove <name>
```

**Behavior:**
- Removes account from database immediately
- Cleans up associated session data
- For confirmation prompts, use the older `agent-smith-cli remove <name>` command

#### `--pause <name>`

Temporarily exclude an account from the load balancer rotation.

**Syntax:**
```bash
agent-smith --pause <name>
```

**Use Cases:**
- Account experiencing issues
- Manual rate limit management
- Maintenance or debugging

#### `--resume <name>`

Re-enable a paused account for load balancing.

**Syntax:**
```bash
agent-smith --resume <name>
```

### Statistics and History

#### `--stats`

Display current statistics in JSON format.

**Syntax:**
```bash
agent-smith --stats
```

**Output:**
Returns JSON-formatted statistics including account usage, request counts, and performance metrics.

#### `--reset-stats`

Reset request counters for all accounts.

**Syntax:**
```bash
agent-smith --reset-stats
```

**Effects:**
- Resets request counts to 0
- Preserves account configuration
- Does not affect rate limit timers

#### `--clear-history`

Remove all request history records.

**Syntax:**
```bash
agent-smith --clear-history
```

**Effects:**
- Deletes request log entries
- Preserves account data
- Reports number of records cleared

### System Commands

#### `--analyze`

Analyze database performance and index usage.

**Syntax:**
```bash
agent-smith --analyze
```

**Output:**
- Database performance metrics
- Index usage statistics
- Query optimization suggestions

#### Interactive Terminal UI (TUI)

Launch the interactive terminal interface (default mode):

```bash
agent-smith
```

**Features:**
- Real-time account monitoring
- Request logs viewing
- Performance analytics
- Interactive account management

### Server and Monitoring

#### `--serve`

Start the API server with dashboard.

**Syntax:**
```bash
agent-smith --serve [--port <number>]
```

**Options:**
- `--port`: Server port (default: 8080, or PORT env var)

**Access:**
- API endpoint: `http://localhost:8080`
- Dashboard: `http://localhost:8080`

#### `run`

Launch Claude Code with its Anthropic base URL pointed at a dedicated local
pool owned by the helper:

```bash
agent-smith run -- -p "hello"
```

Set `AGENT_SMITH_PROXY_KEY` before running the helper. It starts the local proxy itself,
then stops it as soon as Claude exits; it does not attach Claude to an
already-running process. Use `--port <number>` before `--` for a non-default
local port.

#### `--logs [N]`

Stream request logs in real-time.

**Syntax:**
```bash
agent-smith --logs [N]
```

**Options:**
- `N`: Number of historical lines to display before streaming (optional)

**Examples:**
```bash
# Stream live logs only
agent-smith --logs

# Show last 50 lines then stream
agent-smith --logs 50
```

## Usage Examples

### Basic Account Setup

```bash
# Add an Anthropic API key account
agent-smith --add-account work-account --provider anthropic

# Start a Claude Code OAuth flow
agent-smith --add-account personal-account --provider claude-code

# List all accounts
agent-smith --list

# View statistics
agent-smith --stats
```

### Server Operations

```bash
# Start server on default port
agent-smith --serve

# Start server on custom port
agent-smith --serve --port 3000

# Stream logs
agent-smith --logs

# View last 100 lines then stream
agent-smith --logs 100
```

### Managing Rate Limits

```bash
# Pause account hitting rate limits
agent-smith --pause work-account

# Resume after cooldown
agent-smith --resume work-account

# Reset statistics for fresh start
agent-smith --reset-stats
```

### Maintenance Operations

```bash
# Remove account
agent-smith --remove old-account

# Clear old request logs
agent-smith --clear-history

# Analyze database performance
agent-smith --analyze
```

### Interactive Mode

```bash
# Launch interactive TUI (default)
agent-smith

# TUI launches with auto-started server
# Navigate with arrow keys, tab between sections
```

### Automation Examples

```bash
# Add multiple accounts via script
for i in {1..3}; do
  agent-smith --add-account "account-$i" --provider anthropic
done

# Monitor account status
watch -n 5 'agent-smith --list'

# Automated cleanup
agent-smith --clear-history && agent-smith --reset-stats

# Export statistics for monitoring
agent-smith --stats > stats.json
```

## Configuration

### Configuration File Location

agent-smith stores its configuration in platform-specific directories:

#### macOS/Linux
```
~/.config/agent-smith/agent-smith.json
```

Or if `XDG_CONFIG_HOME` is set:
```
$XDG_CONFIG_HOME/agent-smith/agent-smith.json
```

#### Windows
```
%LOCALAPPDATA%\agent-smith\agent-smith.json
```

Or fallback to:
```
%APPDATA%\agent-smith\agent-smith.json
```

### Configuration Structure

```json
{
  "lb_strategy": "session",
  "client_id": "optional-custom-client-id",
  "retry_attempts": 3,
  "retry_delay_ms": 1000,
  "retry_backoff": 2,
  "session_duration_ms": 18000000,
  "port": 8080
}
```

### Database Location

The SQLite database follows the same directory structure:
- **macOS/Linux**: `~/.config/agent-smith/agent-smith.db`
- **Windows**: `%LOCALAPPDATA%\agent-smith\agent-smith.db`

## Environment Variables

### Core Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `AGENT_SMITH_CONFIG_PATH` | Override config file location | Platform default |
| `AGENT_SMITH_DB_PATH` | Override database location | Platform default |
| `PORT` | Server port | 8080 |
| `AGENT_SMITH_CLIENT_ID` | OAuth client ID | 9d1c250a-e61b-44d9-88ed-5944d1962f5e |

### Load Balancing

| Variable | Description | Default |
|----------|-------------|---------|
| `AGENT_SMITH_LB_STRATEGY` | Legacy compatibility setting; unused by quota- and priority-ordered routing | session |

### Retry Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `AGENT_SMITH_RETRY_ATTEMPTS` | Number of retry attempts | 3 |
| `AGENT_SMITH_RETRY_DELAY_MS` | Initial retry delay (ms) | 1000 |
| `AGENT_SMITH_RETRY_BACKOFF` | Exponential backoff multiplier | 2 |

### Session Management

| Variable | Description | Default |
|----------|-------------|---------|
| `AGENT_SMITH_SESSION_DURATION_MS` | Legacy session-strategy duration; unused by the quota-aware proxy kernel | 18000000 (5 hours) |

### Logging and Debugging

| Variable | Description | Default |
|----------|-------------|---------|
| `AGENT_SMITH_LOG_LEVEL` | Log verbosity (DEBUG/INFO/WARN/ERROR) | INFO |
| `AGENT_SMITH_LOG_FORMAT` | Output format (pretty/json) | pretty |
| `AGENT_SMITH_DEBUG` | Enable debug mode (1/0) - enables console output | 0 |

### Pricing and Features

| Variable | Description | Default |
|----------|-------------|---------|
| `AGENT_SMITH_PRICING_REFRESH_HOURS` | Pricing cache duration | 24 |

## Troubleshooting

### Common Issues

#### OAuth Authentication Fails

**Problem**: Browser doesn't open or OAuth callback fails

**Solutions**:
1. Ensure default browser is configured
2. Check firewall settings for localhost:7856
3. Manually copy OAuth URL from terminal
4. Verify network connectivity

#### Account Shows as "Expired"

**Problem**: Token status shows expired

**Solutions**:
1. Remove and re-add the account
2. Check system time synchronization
3. Renew or re-authenticate the OAuth token; the legacy five-hour session value does not control token expiry

#### Rate Limit Errors

**Problem**: Accounts hitting rate limits frequently

**Solutions**:
1. Add more accounts to the pool
2. Inspect quota windows, account priority, and cooldown state with `agent-smith status`
3. Reduce client concurrency or add request throttling
4. Monitor usage with `bun cli list`

#### Database Errors

**Problem**: "Database is locked" or corruption errors

**Solutions**:
1. Stop all agent-smith processes
2. Check file permissions on database
3. Backup and recreate if corrupted:
   ```bash
   cp ~/.config/agent-smith/agent-smith.db ~/.config/agent-smith/agent-smith.db.backup
   rm ~/.config/agent-smith/agent-smith.db
   ```

### Debug Mode

Enable detailed logging for troubleshooting:

```bash
# Enable debug logging
export AGENT_SMITH_DEBUG=1
export AGENT_SMITH_LOG_LEVEL=DEBUG

# Run with verbose output
agent-smith --list

# Stream debug logs
agent-smith --logs
```

### Getting Support

1. Check existing documentation in `/docs`
2. Review debug logs for detailed error messages
3. Ensure all dependencies are up to date
4. File an issue with reproduction steps

### Best Practices

1. **Regular Maintenance**
   - Clear history periodically to manage database size
   - Reset stats monthly for accurate metrics
   - Monitor account health with regular `agent-smith --list` commands
   - Use `agent-smith --analyze` to optimize database performance

2. **Account Management**
   - Use descriptive account names
   - Distribute load across multiple accounts
   - Keep accounts of similar tiers for consistent performance
   - Pause accounts proactively when approaching rate limits

3. **Security**
   - Protect configuration directory permissions
   - Don't share OAuth tokens or session data
   - Rotate accounts periodically
   - Monitor logs with `agent-smith --logs` for suspicious activity

4. **Performance**
   - Use multiple accounts to spread traffic and absorb rate limits
   - Implement client-side retry logic
   - Monitor rate limit patterns with `agent-smith --stats`
   - Run server with `agent-smith --serve` for production use
