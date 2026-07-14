# File Watcher Service - Monorepo Architecture with D365 Integration

**Date:** 2026-07-14
**Status:** Approved
**Project:** Siam AISIN D365 Integration Monitoring & Control

## Context

Original design sent file monitoring events to SigNoz via OpenTelemetry Collector and Gateway.

**Key change:** Send events directly to D365 custom table instead. Remove SigNoz/OpenTelemetry for business monitoring events. Gateway remains as middleware for validation, enrichment, and reliable delivery.

## Architecture Decisions

### 1. Monorepo with apps/ and packages/

**Decision:** Single repository with `apps/` for deployable services and `packages/` for shared libraries.

**Rationale:**
- Watcher and Gateway share event schemas and types
- Atomic updates across service boundaries
- Single build/test/deploy pipeline
- Can split later if needed

### 2. Gateway as Middleware

**Decision:** Keep Gateway between Watcher and D365.

**Responsibilities:**
- Validate events
- Enrich with business context
- Mask sensitive fields
- Persist to outbox (reliable delivery)
- Retry with backoff
- Dead-letter terminal failures

**Rationale:**
- Watcher focuses on file observation
- Gateway handles D365 integration complexity
- Outbox pattern prevents event loss
- Can add other sinks (SigNoz) later without changing Watcher

### 3. Sink Abstraction

**Decision:** Gateway uses sink interface, not direct D365 coupling.

**Current sinks:**
- D365 OData/Data Entity

**Future sinks:**
- SigNoz (for observability)
- Other monitoring systems

**Rationale:**
- D365 is current destination, not permanent constraint
- Sink registry allows multiple destinations
- Gateway logic stays sink-neutral

### 4. Database Ownership

**Watcher schema:**
- `interface_config` - monitoring rules per interface
- `connection_config` - reusable connection metadata
- `watcher_state` - file lifecycle operational state

**Gateway schema:**
- `event_outbox` - pending/delivered events
- `dead_letter_event` - terminal failures
- `delivery_attempt` - retry history

**Development:** Same PostgreSQL server, separate schemas.
**Production:** Can split to separate databases.

### 5. Outbox Status Lifecycle

**States:**
- `PENDING` - not delivered
- `IN_FLIGHT` - delivery in progress
- `DELIVERED` - successfully sent to D365
- `FAILED` - terminal error, moved to dead_letter

**Retention:** Keep DELIVERED records for 30 days (audit trail, duplicate detection), then purge.

## Folder Structure

```
integration-engine/
├── apps/
│   ├── watcher/                              # File Watcher Service (deployable)
│   │   ├── src/
│   │   │   ├── adapters/                     # Technology-specific file observation
│   │   │   │   ├── adapter.ts                # Contract interface
│   │   │   │   ├── adapter-result.ts
│   │   │   │   ├── adapter-registry.ts
│   │   │   │   ├── sftp/
│   │   │   │   │   ├── sftp.adapter.ts
│   │   │   │   │   └── sftp.errors.ts
│   │   │   │   ├── blob/
│   │   │   │   │   ├── blob.adapter.ts
│   │   │   │   │   └── blob-event.normalizer.ts
│   │   │   │   ├── sharepoint/
│   │   │   │   │   ├── sharepoint.adapter.ts
│   │   │   │   │   └── sharepoint-event.normalizer.ts
│   │   │   │   └── folder/
│   │   │   │       └── folder.adapter.ts
│   │   │   ├── config/                       # Interface and Connection configuration
│   │   │   │   ├── config-provider.ts
│   │   │   │   ├── interface-config.model.ts
│   │   │   │   ├── interface-config.repository.ts
│   │   │   │   ├── connection-config.model.ts
│   │   │   │   └── connection-config.repository.ts
│   │   │   ├── connection/                   # Runtime connection context
│   │   │   │   ├── connection-manager.ts
│   │   │   │   ├── connection-context.ts
│   │   │   │   └── connection-errors.ts
│   │   │   ├── secrets/                      # Secret backend abstraction
│   │   │   │   ├── secret-provider.ts
│   │   │   │   ├── env-secret-provider.ts
│   │   │   │   └── key-vault-secret-provider.ts
│   │   │   ├── engine/                       # File lifecycle decision engine
│   │   │   │   ├── watcher-engine.ts
│   │   │   │   ├── interface-matcher.ts
│   │   │   │   ├── batch-id.generator.ts
│   │   │   │   ├── event-builder.ts
│   │   │   │   ├── state-transition.policy.ts
│   │   │   │   └── rules/
│   │   │   │       ├── stability.rule.ts
│   │   │   │       ├── duplicate.rule.ts
│   │   │   │       ├── stuck-file.rule.ts
│   │   │   │       └── missing-sla.rule.ts
│   │   │   ├── scheduler/                    # Orchestrator
│   │   │   │   └── orchestrator.ts
│   │   │   ├── state/                        # Watcher state persistence
│   │   │   │   └── state-repository.ts
│   │   │   ├── gateway-client/               # Event sender
│   │   │   │   └── event-sender.ts
│   │   │   ├── database/
│   │   │   │   ├── client.ts
│   │   │   │   └── migrations/
│   │   │   ├── observability/                # Optional telemetry
│   │   │   │   └── instrumentation.ts
│   │   │   └── index.ts
│   │   ├── test/
│   │   │   ├── unit/
│   │   │   ├── integration/
│   │   │   └── fixtures/
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── gateway/                              # Monitoring Gateway (deployable)
│       ├── src/
│       │   ├── api/                          # HTTP endpoints
│       │   │   ├── routes.ts
│       │   │   └── middleware.ts
│       │   ├── processing/                   # Event processing pipeline
│       │   │   ├── event-processor.ts
│       │   │   ├── event-normalizer.ts
│       │   │   ├── masking.service.ts
│       │   │   └── error-mapper.ts
│       │   ├── enrichment/                   # Business context
│       │   │   └── enrichment-service.ts
│       │   ├── outbox/                       # Reliable delivery
│       │   │   ├── event-outbox.entity.ts
│       │   │   ├── event-outbox.repository.ts
│       │   │   ├── outbox-delivery.worker.ts
│       │   │   ├── retry-policy.ts
│       │   │   └── dead-letter.repository.ts
│       │   ├── sinks/                        # Destination abstraction
│       │   │   ├── monitoring-event-sink.ts
│       │   │   ├── sink-registry.ts
│       │   │   └── d365/
│       │   │       ├── d365-event.sink.ts
│       │   │       ├── d365-client.ts
│       │   │       ├── d365-auth.provider.ts
│       │   │       ├── d365-event.mapper.ts
│       │   │       └── d365-response.classifier.ts
│       │   ├── database/
│       │   │   ├── client.ts
│       │   │   └── migrations/
│       │   ├── observability/                # Optional telemetry
│       │   │   └── instrumentation.ts
│       │   └── index.ts
│       ├── test/
│       │   ├── unit/
│       │   ├── integration/
│       │   └── fixtures/
│       ├── package.json
│       └── tsconfig.json
├── packages/
│   ├── contracts/                            # Shared schemas
│   │   ├── src/
│   │   │   ├── observations/
│   │   │   │   └── file-observation.ts       # Adapter → Engine contract
│   │   │   ├── events/
│   │   │   │   └── file-event.ts             # Watcher → Gateway contract
│   │   │   ├── gateway/
│   │   │   │   └── event-request.ts
│   │   │   ├── config/
│   │   │   │   ├── interface-config.ts
│   │   │   │   └── connection-config.ts
│   │   │   ├── errors/
│   │   │   │   └── error-codes.ts
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   ├── observability/                        # Optional shared telemetry
│   │   ├── src/
│   │   │   ├── telemetry.ts
│   │   │   ├── logger.ts
│   │   │   ├── tracing.ts
│   │   │   ├── metrics.ts
│   │   │   ├── redaction.ts
│   │   │   └── index.ts
│   │   ├── package.json
│   │   └── tsconfig.json
│   └── testing/                              # Optional test utilities
│       ├── src/
│       │   ├── fake-clock.ts
│       │   ├── fake-secret-provider.ts
│       │   ├── fake-adapter.ts
│       │   ├── event-fixtures.ts
│       │   └── index.ts
│       ├── package.json
│       └── tsconfig.json
├── infrastructure/
│   ├── docker/
│   │   └── init.sql                          # Local dev bootstrap only
│   ├── compose/
│   │   └── docker-compose.yml
│   └── scripts/
│       ├── setup-dev.sh
│       └── reset-db.sh
├── docs/
│   ├── architecture.md
│   ├── event-contract.md
│   ├── state-transitions.md
│   └── local-development.md
├── package.json                              # Workspace root
├── tsconfig.base.json
├── .env.example
├── .gitignore
└── README.md
```

## Component Responsibilities

### File Watcher

**Scheduler/Orchestrator:**
- Load enabled interface configurations
- Execute at configured intervals
- Prevent overlapping execution
- Isolate failures per interface

**Config Provider:**
- Retrieve interface configurations (what to watch)
- Retrieve connection configurations (how to connect)
- Validate and cache

**Connection Manager:**
- Resolve connection_ref to connection config
- Call Secret Provider for credentials
- Build runtime connection context

**Secret Provider:**
- Abstract secret backend (env vars, Key Vault)
- Never log secret values
- Only component that accesses secret store

**Adapter Registry:**
- Map storage_type to adapter implementation
- Return ADAPTER_TYPE_NOT_SUPPORTED for unknown types

**Adapters (SFTP, Blob, SharePoint, Folder):**
- Accept resolved connection context and interface scope
- Observe files (list/metadata only, no moves/deletes in MVP)
- Return normalized FileObservation
- Technology-specific, business-neutral
- Do NOT: access state store, generate batch IDs, decide events, retrieve secrets

**Common Watcher Engine:**
- Accept FileObservation + interface config
- Match to interface
- Read existing state
- Decide lifecycle event (FILE_DETECTED, FILE_STABLE, FILE_DUPLICATE, FILE_STUCK, FILE_MISSING_BY_SLA)
- Generate batch_id for new files
- Enforce valid state transitions
- Build FileEvent
- Update state atomically
- Emit event only for meaningful state changes

**State Repository:**
- CRUD operations on watcher_state table
- Atomic state updates
- Concurrency control

**Event Sender:**
- POST FileEvent to Gateway API
- Idempotent via event_id
- Retry transient Gateway failures
- Propagate trace context (if observability enabled)

### Gateway

**API Layer:**
- Receive FileEvent via HTTP POST
- Validate schema
- Return 201 after outbox persist, 4xx for invalid, 5xx for errors

**Event Processor:**
- Normalize event
- Validate business rules
- Mask sensitive fields
- Map technical errors

**Enrichment Service:**
- Add business context (interface metadata, support info)
- Dependency rules (if needed)

**Outbox Repository:**
- Persist event to event_outbox (status=PENDING)
- Atomic insert before ACK to Watcher
- Prevent duplicate event_id

**Delivery Worker:**
- Poll outbox for PENDING events
- Set IN_FLIGHT during delivery
- Send to sink (D365)
- On success: UPDATE status=DELIVERED, delivered_at
- On retriable error: retry with backoff, increment attempts
- On terminal error: move to dead_letter, status=FAILED

**Sink Registry:**
- Map destination to sink implementation
- Current: D365 sink
- Future: SigNoz sink, others

**D365 Sink:**
- Authenticate (OAuth/service principal)
- Map FileEvent to D365 custom table schema
- POST to OData/Data Entity endpoint
- Classify response (success, retriable, terminal)

**Retry Policy:**
- Exponential backoff
- Max attempts configurable
- Classify errors (network timeout = retriable, 401 = terminal)

**Dead Letter Repository:**
- Store terminal failures
- Include original event, error details, timestamps
- Manual review/reprocess interface

## Data Flow

### File Watcher Flow

```
1. Scheduler loads enabled interfaces via Config Provider
2. For each interface:
   a. Connection Manager resolves connection context (calls Secret Provider)
   b. Adapter Registry selects adapter by storage_type
   c. Adapter observes files → FileObservation[]
   d. For each observation:
      - Watcher Engine reads existing state
      - Applies rules (stability, duplicate, stuck, SLA)
      - Decides FileEvent (or no event if no state change)
      - BEGIN TRANSACTION
        - Updates watcher_state
        - Creates FileEvent with event_id
      - COMMIT
      - Event Sender POST to Gateway API
3. Repeat at next interval
```

### Gateway Flow

```
1. API receives FileEvent
2. Processor validates schema
3. BEGIN TRANSACTION
   - INSERT INTO event_outbox (event_id, status=PENDING, payload, ...)
4. COMMIT
5. Return 201 to Watcher (event persisted)
6. Delivery Worker (separate thread/process):
   a. SELECT from event_outbox WHERE status=PENDING ORDER BY created_at LIMIT 100
   b. For each event:
      - UPDATE status=IN_FLIGHT
      - Enrichment Service adds context
      - Masking Service redacts sensitive fields
      - Sink Registry routes to D365 sink
      - D365 Sink authenticates and sends
      - On success:
        - UPDATE event_outbox SET status=DELIVERED, delivered_at=NOW()
      - On retriable error:
        - UPDATE status=PENDING, next_retry_at=NOW() + backoff, attempts=attempts+1
      - On terminal error:
        - INSERT INTO dead_letter_event (event_id, error, ...)
        - UPDATE event_outbox SET status=FAILED
7. Cleanup job (daily):
   - DELETE FROM event_outbox WHERE status=DELIVERED AND delivered_at < NOW() - INTERVAL '30 days'
```

## Atomicity Guarantees

### Watcher State + Event Decision

```sql
BEGIN TRANSACTION;
  -- Check current state
  SELECT * FROM watcher_state WHERE interface_id=? AND file_path=? FOR UPDATE;

  -- Engine decides: FILE_DETECTED → FILE_STABLE (meaningful change)
  UPDATE watcher_state
  SET previous_status='FILE_DETECTED',
      current_status='FILE_STABLE',
      status_changed_at=NOW(),
      last_seen_at=NOW();

  -- Create event in memory (not persisted to Watcher DB)
  FileEvent { event_id, event_type='FILE_STABLE', batch_id, ... }
COMMIT;

-- After commit, send event to Gateway
POST /api/events
```

State update atomic. Event send happens after commit. If Gateway fails, Watcher can retry (Gateway deduplicates via event_id).

### Gateway Outbox + ACK

```sql
-- Gateway receives FileEvent
BEGIN TRANSACTION;
  -- Idempotency check
  SELECT event_id FROM event_outbox WHERE event_id=?;
  IF EXISTS THEN RETURN 200 (already processed);

  -- Persist before ACK
  INSERT INTO event_outbox (
    event_id,
    status='PENDING',
    payload=?,
    created_at=NOW()
  );
COMMIT;

-- Return 201 Created to Watcher
```

Event persisted before ACK. If Gateway crashes before ACK, Watcher retries, Gateway detects duplicate event_id, returns 200.

### Outbox Delivery

Delivery Worker reads from outbox, sends to D365, updates status. If crash during delivery:
- Status IN_FLIGHT events revert to PENDING after timeout
- Next worker picks up and retries
- D365 receives duplicate (D365 should handle via event_id or timestamp)

## Key Changes from Original Context Doc

### 1. Remove SigNoz/OpenTelemetry for Business Events

**Original:** Watcher → Gateway → OpenTelemetry Collector → SigNoz
**New:** Watcher → Gateway → D365

**Rationale:** D365 custom table is current long-term event store. SigNoz optional for technical telemetry only.

### 2. Rename Gateway Persistence to Outbox

**Original:** `persistence/event-repository.ts`
**New:** `outbox/event-outbox.repository.ts`

**Rationale:** Clarifies temporary durable storage for delivery, not long-term event store.

### 3. Sink Abstraction

**Original:** Direct D365 coupling
**New:** `sinks/monitoring-event-sink.ts` interface, `sinks/d365/` implementation

**Rationale:** Can add SigNoz or other destinations later without changing Gateway core logic.

### 4. Separate Interface Config and Connection Config

**Original:** Single config store
**New:** Separate repositories

**Example:**
```
connection_config:
  connection_ref: sftp-agdoc-prod
  storage_type: SFTP
  host: sftp.agdoc.com
  port: 22
  credential_ref: sftp-agdoc-key

interface_config:
  interface_id: SA-034
  connection_ref: sftp-agdoc-prod
  inbound_path: /ag-doc/vendor-invoice/inbound/
  file_pattern: VendorInvoice_*.xlsx
  poll_interval_seconds: 60
  stability_check_seconds: 30
```

Many interfaces reuse one connection.

### 5. Common Adapter Contract

**Original:** Ad-hoc adapter implementations
**New:** `adapters/adapter.ts` interface, technology-specific folders

**Contract:**
```typescript
interface Adapter {
  observe(context: ConnectionContext, scope: InterfaceScope): Promise<FileObservation[]>;
}
```

All adapters return normalized FileObservation. Watcher Engine decides events.

### 6. Watcher Engine Rule Modules

**Original:** Monolithic engine
**New:** Separate rules (stability, duplicate, stuck, SLA)

**Rationale:** Easier to test and modify individual rules without touching entire engine.

### 7. Database Migrations

**Original:** `docker/init.sql` only
**New:** `apps/watcher/src/database/migrations/` and `apps/gateway/src/database/migrations/`

**Rationale:** `docker/init.sql` bootstraps local dev only. Apps own schema evolution.

### 8. Test Structure

**New:**
- `apps/watcher/test/` - adapter normalization, engine rules, state transitions
- `apps/gateway/test/` - API validation, outbox delivery, retry logic, dead-letter

**Rationale:** Both services need comprehensive unit and integration tests.

## Observability (Optional)

OpenTelemetry SDK and SigNoz removed for business monitoring events. Can add back later for technical telemetry:

**If enabled:**
- `packages/observability/` provides logger, metrics, tracing
- Watcher and Gateway embed instrumentation
- Send telemetry to OpenTelemetry Collector → SigNoz
- Separate from business event flow

**MVP:** Optional. Focus on reliable D365 delivery first.

## Deployment

**Development:**
- npm workspaces
- TypeScript project references
- Single `docker-compose.yml` (PostgreSQL, Redis if needed)
- `npm run dev:watcher` and `npm run dev:gateway`

**Production:**
- Build: `npm run build` (compiles all apps and packages)
- Deploy Watcher: Docker image from `apps/watcher/`
- Deploy Gateway: Docker image from `apps/gateway/`
- Separate database schemas or databases
- Environment-specific configs (.env)

**Workspace tooling:** Start with npm workspaces. Add Turborepo/Lerna later if needed.

## Testing Strategy

### Watcher Tests

**Unit:**
- Adapter normalization (SFTP metadata → FileObservation)
- Interface matching
- New file detection
- Stability rule (size unchanged for threshold)
- Duplicate rule (same path/checksum)
- Stuck file detection (active past threshold)
- Missing SLA (no file by schedule)
- State transitions (FILE_DETECTED → FILE_STABLE valid, FILE_STABLE → FILE_DETECTED invalid)
- Batch ID generation
- Secret redaction in logs

**Integration:**
- Config Provider loads from database
- Connection Manager resolves credentials
- Adapter connects to real SFTP/Blob/folder
- State Repository persists and retrieves state
- Event Sender POST to Gateway API

### Gateway Tests

**Unit:**
- Event validation (schema, required fields)
- Enrichment adds metadata
- Masking redacts sensitive fields
- Outbox idempotency (duplicate event_id)
- Retry policy (backoff calculation, max attempts)
- Error classification (retriable vs terminal)
- D365 response mapping

**Integration:**
- API accepts valid event, returns 201
- API rejects invalid event, returns 400
- Outbox persists before ACK
- Delivery Worker sends to D365
- Retry on transient failure
- Dead-letter on terminal failure
- Cleanup job deletes old DELIVERED records

## Security

**Secrets:**
- Never log passwords, tokens, keys, certificates
- Secret Provider only component accessing secret backend
- Connection Manager receives resolved secrets, never logs them
- Adapters use credentials, never log them
- Event payloads mask sensitive fields before persistence

**Database:**
- Watcher and Gateway use separate schemas/credentials
- Least privilege (Watcher reads config, writes state; Gateway reads/writes outbox)
- No direct table access by external systems

**API:**
- Gateway API requires authentication (API key, OAuth)
- Validate all inputs
- Rate limiting

**D365:**
- OAuth/service principal
- Least privilege (insert only to custom table)
- Rotate credentials regularly

## MVP Scope

**Include:**
- Monorepo structure (apps/watcher, apps/gateway, packages/contracts)
- SFTP adapter
- Network/local folder adapter
- Interface and Connection config
- Environment variable Secret Provider
- Common Watcher Engine with stability and duplicate rules
- State Repository
- Event Sender
- Gateway API
- Outbox pattern with retry
- D365 sink

**Defer:**
- Azure Blob adapter (Event Grid mode)
- SharePoint adapter
- Key Vault Secret Provider
- Stuck file detection
- Missing SLA detection
- SigNoz observability
- Advanced retry policies
- Config UI
- Reprocessing UI

## Success Criteria

1. Watcher detects new file, emits FILE_DETECTED event
2. Watcher detects stable file (size unchanged), emits FILE_STABLE event
3. Gateway receives event, persists to outbox, ACKs to Watcher
4. Gateway delivers event to D365 custom table
5. Gateway retries on transient D365 failure
6. Gateway moves to dead-letter on terminal failure
7. Watcher state persists across restarts (no duplicate events)
8. Gateway outbox survives restarts (events delivered eventually)
9. Duplicate event_id handled idempotently
10. No secrets in logs or event payloads

## Next Steps

1. Scaffold monorepo structure
2. Set up npm workspaces and TypeScript project references
3. Create packages/contracts (event schemas)
4. Implement Watcher MVP (scheduler, SFTP adapter, engine, state store)
5. Implement Gateway MVP (API, outbox, D365 sink)
6. Integration testing (Watcher → Gateway → D365)
7. Add remaining adapters (Blob, SharePoint, folder)
8. Add remaining rules (stuck, missing SLA)
9. Add observability (optional)
10. Production deployment
