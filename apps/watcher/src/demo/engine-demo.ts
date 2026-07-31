import { config } from 'dotenv';
import path from 'path';
import { processObservation } from '../engine/watcher-engine';
import { checkMissingSla } from '../engine/missing-sla-sweep';
import { PostgresStateRepository } from '../database/repositories/state.repository';
import { InterfaceConfigRepository } from '../database/repositories/interface-config.repository';
import { DatabaseClient } from '../database/client';
import type { FileObservation, InterfaceConfig } from '@packages/contracts';

// Load .env file from root directory
config({ path: path.resolve(__dirname, '../../../../.env') });

// Utility: simulate time passing
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Utility: format date for display
function formatTime(date: Date): string {
  return date.toISOString().replace('T', ' ').substring(0, 19) + 'Z';
}

async function runScenario1_DuplicateDetection(
  config: InterfaceConfig,
  stateRepo: PostgresStateRepository,
  startTime: Date
): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('Scenario 1: Duplicate Detection (Happy Path)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const filePath = '/inbound/vendor-invoice-001.xlsx';
  const fileSize = 1024;

  // Observation 1: First detection
  console.log(`[${formatTime(startTime)}] Processing observation 1: ${filePath} (${fileSize} bytes)`);

  const observation1: FileObservation = {
    interfaceId: config.interfaceId,
    path: filePath,
    size: fileSize,
    mtime: startTime,
  };

  const event1 = await processObservation(observation1, config, stateRepo, startTime);

  if (event1) {
    console.log(`  → Event: ${event1.eventType} (batch: ${event1.batchId})`);
    console.log(`  → State saved to database\n`);
  }

  // Simulate 35 seconds passing (exceeds stabilityCheckSeconds: 30)
  await sleep(100); // Actual sleep is short, but we advance the timestamp by 35s
  const time2 = new Date(startTime.getTime() + 35 * 1000);

  console.log(`[${formatTime(time2)}] Processing observation 2: ${filePath} (${fileSize} bytes, +35s)`);

  const observation2: FileObservation = {
    interfaceId: config.interfaceId,
    path: filePath,
    size: fileSize,
    mtime: startTime, // Same mtime (file hasn't changed)
  };

  const event2 = await processObservation(observation2, config, stateRepo, time2);

  if (event2) {
    console.log(`  → Event: ${event2.eventType} (batch: ${event2.batchId})`);
    console.log(`  → State updated: FILE_DETECTED → FILE_STABLE\n`);
  }

  // Observation 3: Same file again (duplicate)
  await sleep(100);
  const time3 = new Date(time2.getTime() + 60 * 1000);

  console.log(`[${formatTime(time3)}] Processing observation 3: ${filePath} (${fileSize} bytes, same file)`);

  const observation3: FileObservation = {
    interfaceId: config.interfaceId,
    path: filePath,
    size: fileSize,
    mtime: startTime,
  };

  const event3 = await processObservation(observation3, config, stateRepo, time3);

  if (event3) {
    console.log(`  → Event: ${event3.eventType} (batch: ${event3.batchId})`);
    console.log(`  → State updated: FILE_STABLE → FILE_DUPLICATE\n`);
  }

  // Show final state
  const finalState = await stateRepo.get(config.interfaceId, filePath);
  console.log('Final state in database:');
  console.log(`  Interface: ${finalState?.interfaceId}`);
  console.log(`  File: ${finalState?.filePath}`);
  console.log(`  Status: ${finalState?.currentStatus}`);
  console.log(`  Batch: ${finalState?.batchId}`);
  console.log(`  First detected: ${formatTime(finalState!.firstDetectedAt)}\n`);
}

async function runScenario2_StuckFile(
  config: InterfaceConfig,
  stateRepo: PostgresStateRepository,
  startTime: Date
): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('Scenario 2: Stuck File');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const filePath = '/inbound/stuck-file.xlsx';
  const fileSize = 2048;

  // Observation 1: First detection
  console.log(`[${formatTime(startTime)}] Processing observation 1: ${filePath} (${fileSize} bytes)`);

  const observation1: FileObservation = {
    interfaceId: config.interfaceId,
    path: filePath,
    size: fileSize,
    mtime: startTime,
  };

  const event1 = await processObservation(observation1, config, stateRepo, startTime);

  if (event1) {
    console.log(`  → Event: ${event1.eventType} (batch: ${event1.batchId})`);
    console.log(`  → State saved to database\n`);
  }

  // Simulate 90 minutes passing (exceeds stuckThresholdSeconds: 3600 = 60 minutes)
  await sleep(100);
  const time2 = new Date(startTime.getTime() + 90 * 60 * 1000);

  console.log(`[${formatTime(time2)}] Processing observation 2: ${filePath} (${fileSize} bytes, +90min)`);

  const observation2: FileObservation = {
    interfaceId: config.interfaceId,
    path: filePath,
    size: fileSize, // Same size (no growth)
    mtime: startTime, // Same mtime
  };

  const event2 = await processObservation(observation2, config, stateRepo, time2);

  if (event2) {
    console.log(`  → Event: ${event2.eventType} (batch: ${event2.batchId})`);
    console.log(`  → State updated: FILE_DETECTED → FILE_STUCK\n`);
  }

  // Show final state
  const finalState = await stateRepo.get(config.interfaceId, filePath);
  console.log('Final state in database:');
  console.log(`  Interface: ${finalState?.interfaceId}`);
  console.log(`  File: ${finalState?.filePath}`);
  console.log(`  Status: ${finalState?.currentStatus}`);
  console.log(`  Batch: ${finalState?.batchId}\n`);
}

async function runScenario3_MissingSLA(
  config: InterfaceConfig,
  stateRepo: PostgresStateRepository,
  startTime: Date
): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('Scenario 3: Missing by SLA');
  console.log('═══════════════════════════════════════════════════════════════\n');

  // Time is after SLA deadline (18:00 UTC)
  const checkTime = new Date('2026-07-16T18:30:00Z');

  console.log(`[${formatTime(checkTime)}] Checking for missing files (SLA deadline: ${config.slaDeadline})`);

  // No files arrived today - should trigger FILE_MISSING_BY_SLA
  const events = await checkMissingSla(config, stateRepo, checkTime);

  if (events.length > 0) {
    console.log(`  → Event: ${events[0].eventType} (batch: ${events[0].batchId})`);
    console.log(`  → Expected file never arrived\n`);
  }

  // Show sentinel state
  const sentinelState = await stateRepo.get(config.interfaceId, '__sla_window__');
  console.log('Final state in database:');
  console.log(`  Interface: ${sentinelState?.interfaceId}`);
  console.log(`  File: ${sentinelState?.filePath} (sentinel)`);
  console.log(`  Status: ${sentinelState?.currentStatus}`);
  console.log(`  Batch: ${sentinelState?.batchId}\n`);
}

async function main() {
  console.log('🚀 Engine + PostgresStateRepository Integration Demo\n');

  try {
    // Load interface config from database
    const configRepo = new InterfaceConfigRepository();
    const loadedConfig = await configRepo.findById('SA-034');

    if (!loadedConfig) {
      throw new Error('Interface config SA-034 not found. Run migrations and seed test data first.');
    }

    // Add engine-specific fields (MVP model)
    const config: InterfaceConfig = {
      ...loadedConfig,
      stuckThresholdSeconds: 3600, // 60 minutes
      slaDeadline: '18:00', // 6 PM UTC
    };

    // Create Postgres repository
    const stateRepo = new PostgresStateRepository();

    // Clean state for demo
    const db = DatabaseClient.getInstance();
    await db.query('TRUNCATE TABLE watcher_schema.watcher_state CASCADE');

    const startTime = new Date('2026-07-16T10:00:00Z');

    // Run all 3 scenarios
    await runScenario1_DuplicateDetection(config, stateRepo, startTime);

    await runScenario2_StuckFile(config, stateRepo, new Date('2026-07-16T11:00:00Z'));

    // Clean state before Scenario 3 (SLA check expects no files today)
    await db.query('TRUNCATE TABLE watcher_schema.watcher_state CASCADE');
    await runScenario3_MissingSLA(config, stateRepo, new Date('2026-07-16T18:30:00Z'));

    // Close connection
    await DatabaseClient.getInstance().close();

    console.log('✅ Demo completed successfully\n');
  } catch (error) {
    // Re-throw to be caught by outer catch block
    throw error;
  }
}

main().catch((error) => {
  console.error('❌ Demo failed:', error.message);
  console.error('');
  console.error('Prerequisites:');
  console.error('  1. Database running: docker compose -f infrastructure/compose/docker-compose.yml up -d');
  console.error('  2. Migrations applied: cd apps/watcher && npm run migrate:up');
  console.error('  3. Interface config seeded (SA-034) - see test fixtures');
  process.exit(1);
});
