# Integration Engine

File Watcher Service for D365 Integration Monitoring & Control

## Prerequisites

- Docker Desktop
- Node.js LTS (via nvm)
- Git

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Copy environment file:
   ```bash
   cp .env.example .env
   ```

3. Start infrastructure:
   ```bash
   docker-compose up -d
   ```

4. Verify database:
   ```bash
   docker-compose ps
   ```

5. Build project:
   ```bash
   npm run build
   ```

## Development

- `npm run dev` - Run with ts-node (no compilation)
- `npm run build` - Compile TypeScript
- `npm start` - Run compiled code

## Architecture

See `docs/superpowers/specs/2026-07-14-initial-setup-design.md` for design details.
