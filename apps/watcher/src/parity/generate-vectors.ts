/**
 * Parity test-vector generator.
 *
 * Executes the frozen TypeScript engine (the executable reference spec) against
 * the scenario set mirroring the vitest suite, records the actual outcomes, and
 * writes docs/superpowers/specs/parity/engine-test-vectors.json for the C# port
 * to consume as data-driven tests.
 *
 * Self-verifying: each scenario declares its expected outcome (same expectation
 * the vitest suite asserts); the generator throws if execution disagrees, so a
 * regenerated file can never silently drift from the reference engine.
 *
 * Run: npm run parity:vectors -w @apps/watcher
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FileObservation, FileStatus, InterfaceConfig, WatcherState } from '@packages/contracts';
import { processObservation } from '../engine/watcher-engine';
import { checkMissingSla } from '../engine/missing-sla-sweep';
import { assertValidTransition } from '../engine/state-transition.policy';
import { assertInterfaceMatch } from '../engine/interface-matcher';
import { duplicateRule } from '../engine/rules/duplicate.rule';
import { stuckFileRule } from '../engine/rules/stuck-file.rule';
import { stabilityRule } from '../engine/rules/stability.rule';
import type { Rule } from '../engine/rules/rule';
import { InMemoryStateRepository } from '../engine/state/in-memory-state-repository';

const OUT_PATH = resolve(__dirname, '../../../../docs/superpowers/specs/parity/engine-test-vectors.json');

const T0 = new Date('2026-07-17T06:00:00.000Z');
const sec = (s: number) => new Date(T0.getTime() + s * 1000);

const baseConfig: InterfaceConfig = {
  interfaceId: 'SA-034',
  interfaceName: 'Vendor Invoice',
  sourceSystem: 'SFTP_SERVER',
  targetSystem: 'D365',
  connectionRef: 'sftp-test',
  inboundPath: '/in/',
  filePattern: '.*\\.csv$',
  pollIntervalSeconds: 60,
  readinessRule: 'STABLE_SIZE',
  stabilityCheckSeconds: 30,
  duplicateCheckEnabled: true,
  stuckThresholdMinutes: null,
  expectedSchedule: null,
  slaThresholdMinutes: null,
  alertOwner: null,
  enabledFlag: true,
  stuckThresholdSeconds: 3600,
  slaDeadline: '08:00',
};

const baseState = (over: Partial<WatcherState>): WatcherState => ({
  interfaceId: 'SA-034',
  filePath: '/in/a.csv',
  currentStatus: 'FILE_DETECTED',
  previousStatus: null,
  batchId: 'batch-1',
  firstDetectedAt: T0,
  statusChangedAt: T0,
  lastSeenAt: T0,
  fileName: 'a.csv',
  fileSizeBytes: 100,
  ...over,
});

const obs = (over: Partial<FileObservation> = {}): FileObservation => ({
  interfaceId: 'SA-034',
  path: '/in/a.csv',
  size: 100,
  mtime: T0,
  ...over,
});

// ---------------------------------------------------------------- policy ----

const policyCases: Array<{ from: FileStatus | null; to: FileStatus; allowed: boolean }> = [
  { from: null, to: 'FILE_DETECTED', allowed: true },
  { from: null, to: 'FILE_MISSING_BY_SLA', allowed: true },
  { from: 'FILE_DETECTED', to: 'FILE_STABLE', allowed: true },
  { from: 'FILE_DETECTED', to: 'FILE_STUCK', allowed: true },
  { from: 'FILE_STABLE', to: 'FILE_DUPLICATE', allowed: true },
  { from: 'FILE_STUCK', to: 'FILE_STABLE', allowed: true },
  { from: 'FILE_MISSING_BY_SLA', to: 'FILE_MISSING_BY_SLA', allowed: true },
  { from: 'FILE_STABLE', to: 'FILE_DETECTED', allowed: false },
  { from: 'FILE_DUPLICATE', to: 'FILE_STABLE', allowed: false },
  { from: 'FILE_STUCK', to: 'FILE_DUPLICATE', allowed: false },
  { from: 'FILE_DETECTED', to: 'FILE_MISSING_BY_SLA', allowed: false },
  { from: null, to: 'FILE_STABLE', allowed: false },
];

for (const c of policyCases) {
  let allowed = true;
  try {
    assertValidTransition(c.from, c.to);
  } catch {
    allowed = false;
  }
  if (allowed !== c.allowed) {
    throw new Error(`policy drift: ${c.from} -> ${c.to} expected allowed=${c.allowed}, got ${allowed}`);
  }
}

// ----------------------------------------------------------------- rules ----

interface RuleVector {
  matrixRef: string;
  name: string;
  observation: FileObservation;
  state: WatcherState | null;
  config: InterfaceConfig;
  now: string;
  expectedStatus: FileStatus | null;
}

const rules: Record<string, Rule> = {
  duplicate: duplicateRule,
  stuckFile: stuckFileRule,
  stability: stabilityRule,
};

const ruleCases: Array<{ rule: keyof typeof rules } & Omit<RuleVector, 'now'> & { now: Date }> = [
  // duplicate.rule — DuplicateRuleTests
  { rule: 'duplicate', matrixRef: 'DuplicateRuleTests.ReturnsNull_WhenNoPriorState', name: 'no prior state', observation: obs(), state: null, config: baseConfig, now: T0, expectedStatus: null },
  { rule: 'duplicate', matrixRef: 'DuplicateRuleTests.FiresFileDuplicate_WhenPriorStatusFileStable', name: 'prior FILE_STABLE', observation: obs(), state: baseState({ currentStatus: 'FILE_STABLE' }), config: baseConfig, now: T0, expectedStatus: 'FILE_DUPLICATE' },
  { rule: 'duplicate', matrixRef: 'DuplicateRuleTests.FiresFileDuplicate_WhenPriorStatusFileDuplicate', name: 'prior FILE_DUPLICATE', observation: obs(), state: baseState({ currentStatus: 'FILE_DUPLICATE' }), config: baseConfig, now: T0, expectedStatus: 'FILE_DUPLICATE' },
  { rule: 'duplicate', matrixRef: 'DuplicateRuleTests.ReturnsNull_WhenPriorStatusNonTerminal', name: 'prior non-terminal', observation: obs(), state: baseState({ currentStatus: 'FILE_DETECTED' }), config: baseConfig, now: T0, expectedStatus: null },
  // stuck-file.rule — StuckFileRuleTests
  { rule: 'stuckFile', matrixRef: 'StuckFileRuleTests.ReturnsNull_WhenNoPriorState', name: 'no prior state', observation: obs(), state: null, config: baseConfig, now: T0, expectedStatus: null },
  { rule: 'stuckFile', matrixRef: 'StuckFileRuleTests.ReturnsNull_WhenElapsedUnderThreshold', name: 'under threshold', observation: obs(), state: baseState({}), config: baseConfig, now: sec(3599), expectedStatus: null },
  { rule: 'stuckFile', matrixRef: 'StuckFileRuleTests.FiresFileStuck_WhenThresholdMet_AndStatusNonTerminal', name: 'threshold met, non-terminal', observation: obs(), state: baseState({}), config: baseConfig, now: sec(3600), expectedStatus: 'FILE_STUCK' },
  { rule: 'stuckFile', matrixRef: 'StuckFileRuleTests.ReturnsNull_WhenStatusTerminal', name: 'terminal FILE_STABLE', observation: obs(), state: baseState({ currentStatus: 'FILE_STABLE' }), config: baseConfig, now: sec(7200), expectedStatus: null },
  // stability.rule — StabilityRuleTests
  { rule: 'stability', matrixRef: 'StabilityRuleTests.ReturnsNull_WhenNoPriorState', name: 'no prior state', observation: obs(), state: null, config: baseConfig, now: T0, expectedStatus: null },
  { rule: 'stability', matrixRef: 'StabilityRuleTests.ReturnsNull_WhenStatusNotFileDetected', name: 'status not FILE_DETECTED', observation: obs(), state: baseState({ currentStatus: 'FILE_STUCK' }), config: baseConfig, now: sec(60), expectedStatus: null },
  { rule: 'stability', matrixRef: 'StabilityRuleTests.ReturnsNull_WhenSizeChanged', name: 'size changed', observation: obs({ size: 200 }), state: baseState({}), config: baseConfig, now: sec(60), expectedStatus: null },
  { rule: 'stability', matrixRef: 'StabilityRuleTests.ReturnsNull_WhenUnderStabilityWindow', name: 'under stability window', observation: obs(), state: baseState({}), config: baseConfig, now: sec(29), expectedStatus: null },
  { rule: 'stability', matrixRef: 'StabilityRuleTests.FiresFileStable_WhenSizeUnchanged_AndWindowElapsed', name: 'stable', observation: obs(), state: baseState({}), config: baseConfig, now: sec(30), expectedStatus: 'FILE_STABLE' },
];

const ruleVectors: Array<RuleVector & { rule: string }> = ruleCases.map((c) => {
  const outcome = rules[c.rule](c.observation, c.state, c.config, c.now);
  const actual = outcome ? outcome.status : null;
  if (actual !== c.expectedStatus) {
    throw new Error(`rule drift [${c.matrixRef}]: expected ${c.expectedStatus}, got ${actual}`);
  }
  return { ...c, now: c.now.toISOString(), expectedStatus: actual };
});

// --------------------------------------------------------------- matcher ----

const matcherVectors = [
  { matrixRef: 'InterfaceMatcherTests.DoesNotThrow_WhenInterfaceMatches', observationInterfaceId: 'SA-034', configInterfaceId: 'SA-034', throws: false },
  { matrixRef: 'InterfaceMatcherTests.Throws_WhenInterfaceDiffers', observationInterfaceId: 'SA-999', configInterfaceId: 'SA-034', throws: true },
].map((c) => {
  let threw = false;
  try {
    assertInterfaceMatch(obs({ interfaceId: c.observationInterfaceId }), { ...baseConfig, interfaceId: c.configInterfaceId });
  } catch {
    threw = true;
  }
  if (threw !== c.throws) throw new Error(`matcher drift [${c.matrixRef}]`);
  return c;
});

// ---------------------------------------------------- engine (multi-step) ----

interface EngineStep {
  observation: FileObservation;
  now: string;
  expect: {
    eventType: FileStatus | null;   // null = no event returned
    throws: string | null;          // error name, if the call must throw
    stateAfter: { currentStatus: FileStatus; previousStatus: FileStatus | null; fileName: string } | null;
    batchIdSameAsStep: number | null; // index of earlier step whose event batchId must match
  };
}

interface EngineScenario {
  matrixRef: string;
  name: string;
  config: InterfaceConfig;
  steps: EngineStep[];
}

async function runEngineScenario(s: EngineScenario): Promise<void> {
  const repo = new InMemoryStateRepository();
  const batchIds: Array<string | null> = [];
  for (let i = 0; i < s.steps.length; i++) {
    const step = s.steps[i];
    let event = null;
    let threwName: string | null = null;
    try {
      event = await processObservation(step.observation, s.config, repo, new Date(step.now));
    } catch (e) {
      threwName = (e as Error).constructor.name;
    }
    batchIds.push(event ? event.batchId : null);
    const e = step.expect;
    if (threwName !== e.throws) throw new Error(`${s.matrixRef} step ${i}: throws=${threwName}, expected ${e.throws}`);
    if ((event ? event.eventType : null) !== e.eventType) {
      throw new Error(`${s.matrixRef} step ${i}: eventType=${event ? event.eventType : null}, expected ${e.eventType}`);
    }
    if (e.stateAfter) {
      const st = await repo.get(step.observation.interfaceId, step.observation.path);
      if (!st || st.currentStatus !== e.stateAfter.currentStatus || st.previousStatus !== e.stateAfter.previousStatus || st.fileName !== e.stateAfter.fileName) {
        throw new Error(`${s.matrixRef} step ${i}: stateAfter mismatch (${st?.currentStatus}/${st?.previousStatus}/${st?.fileName})`);
      }
    }
    if (e.batchIdSameAsStep !== null) {
      if (!event || batchIds[e.batchIdSameAsStep] !== event.batchId) {
        throw new Error(`${s.matrixRef} step ${i}: batchId not reused from step ${e.batchIdSameAsStep}`);
      }
    }
  }
}

const stuckFastConfig: InterfaceConfig = { ...baseConfig, stuckThresholdSeconds: 60 };

const engineScenarios: EngineScenario[] = [
  {
    matrixRef: 'WatcherEngineTests.EmitsFileDetected_ForNewFile_AndPersistsStateWithFileName',
    name: 'brand-new file',
    config: baseConfig,
    steps: [
      { observation: obs(), now: T0.toISOString(), expect: { eventType: 'FILE_DETECTED', throws: null, stateAfter: { currentStatus: 'FILE_DETECTED', previousStatus: null, fileName: 'a.csv' }, batchIdSameAsStep: null } },
    ],
  },
  {
    matrixRef: 'WatcherEngineTests.EmitsFileStable_AfterStabilityWindow',
    name: 'detect then stable',
    config: baseConfig,
    steps: [
      { observation: obs(), now: T0.toISOString(), expect: { eventType: 'FILE_DETECTED', throws: null, stateAfter: null, batchIdSameAsStep: null } },
      { observation: obs(), now: sec(31).toISOString(), expect: { eventType: 'FILE_STABLE', throws: null, stateAfter: { currentStatus: 'FILE_STABLE', previousStatus: 'FILE_DETECTED', fileName: 'a.csv' }, batchIdSameAsStep: null } },
    ],
  },
  {
    matrixRef: 'WatcherEngineTests.ReusesBatchId_AcrossLifecycle',
    name: 'batchId reuse',
    config: baseConfig,
    steps: [
      { observation: obs(), now: T0.toISOString(), expect: { eventType: 'FILE_DETECTED', throws: null, stateAfter: null, batchIdSameAsStep: null } },
      { observation: obs(), now: sec(31).toISOString(), expect: { eventType: 'FILE_STABLE', throws: null, stateAfter: null, batchIdSameAsStep: 0 } },
    ],
  },
  {
    matrixRef: 'WatcherEngineTests.ReturnsNull_WhenNoMeaningfulChange',
    name: 'no meaningful change',
    config: baseConfig,
    steps: [
      { observation: obs(), now: T0.toISOString(), expect: { eventType: 'FILE_DETECTED', throws: null, stateAfter: null, batchIdSameAsStep: null } },
      { observation: obs(), now: sec(10).toISOString(), expect: { eventType: null, throws: null, stateAfter: { currentStatus: 'FILE_DETECTED', previousStatus: null, fileName: 'a.csv' }, batchIdSameAsStep: null } },
    ],
  },
  {
    matrixRef: 'WatcherEngineTests.EmitsFileDuplicate_WhenStableFileReobserved',
    name: 'duplicate after stable',
    config: baseConfig,
    steps: [
      { observation: obs(), now: T0.toISOString(), expect: { eventType: 'FILE_DETECTED', throws: null, stateAfter: null, batchIdSameAsStep: null } },
      { observation: obs(), now: sec(31).toISOString(), expect: { eventType: 'FILE_STABLE', throws: null, stateAfter: null, batchIdSameAsStep: null } },
      { observation: obs(), now: sec(40).toISOString(), expect: { eventType: 'FILE_DUPLICATE', throws: null, stateAfter: { currentStatus: 'FILE_DUPLICATE', previousStatus: 'FILE_STABLE', fileName: 'a.csv' }, batchIdSameAsStep: 0 } },
    ],
  },
  {
    matrixRef: 'WatcherEngineTests.ReturnsNull_WhenStuckFileReobservedSameStatus',
    name: 'stuck re-observed is a no-op',
    config: stuckFastConfig,
    steps: [
      { observation: obs({ size: 100 }), now: T0.toISOString(), expect: { eventType: 'FILE_DETECTED', throws: null, stateAfter: null, batchIdSameAsStep: null } },
      { observation: obs({ size: 200 }), now: sec(61).toISOString(), expect: { eventType: 'FILE_STUCK', throws: null, stateAfter: null, batchIdSameAsStep: null } },
      { observation: obs({ size: 300 }), now: sec(70).toISOString(), expect: { eventType: null, throws: null, stateAfter: { currentStatus: 'FILE_STUCK', previousStatus: 'FILE_DETECTED', fileName: 'a.csv' }, batchIdSameAsStep: null } },
    ],
  },
  {
    matrixRef: 'WatcherEngineTests.Throws_WhenInterfaceMismatch',
    name: 'interface mismatch throws',
    config: baseConfig,
    steps: [
      { observation: obs({ interfaceId: 'SA-999' }), now: T0.toISOString(), expect: { eventType: null, throws: 'InterfaceMismatchError', stateAfter: null, batchIdSameAsStep: null } },
    ],
  },
];

// ------------------------------------------------------ sweep (multi-step) ----

interface SweepStep {
  now: string;
  expectEventCount: number;
}

interface SweepScenario {
  matrixRef: string;
  name: string;
  config: InterfaceConfig;
  seedStates: WatcherState[];
  steps: SweepStep[];
}

async function runSweepScenario(s: SweepScenario): Promise<void> {
  const repo = new InMemoryStateRepository();
  for (const st of s.seedStates) await repo.save(st);
  for (let i = 0; i < s.steps.length; i++) {
    const step = s.steps[i];
    const events = await checkMissingSla(s.config, repo, new Date(step.now));
    if (events.length !== step.expectEventCount) {
      throw new Error(`${s.matrixRef} step ${i}: got ${events.length} events, expected ${step.expectEventCount}`);
    }
    for (const ev of events) {
      if (ev.eventType !== 'FILE_MISSING_BY_SLA' || ev.filePath !== null) {
        throw new Error(`${s.matrixRef} step ${i}: bad event shape`);
      }
    }
  }
}

const day = (d: string, hm: string) => new Date(`2026-07-${d}T${hm}:00.000Z`).toISOString();

const sweepScenarios: SweepScenario[] = [
  {
    matrixRef: 'MissingSlaSweepTests.NoEvents_BeforeDeadline',
    name: 'before deadline',
    config: baseConfig,
    seedStates: [],
    steps: [{ now: day('17', '07:00'), expectEventCount: 0 }],
  },
  {
    matrixRef: 'MissingSlaSweepTests.NoEvents_AfterDeadline_WhenFileArrivedToday',
    name: 'file arrived today',
    config: baseConfig,
    seedStates: [baseState({ firstDetectedAt: new Date(day('17', '06:00')), statusChangedAt: new Date(day('17', '06:00')), lastSeenAt: new Date(day('17', '06:00')) })],
    steps: [{ now: day('17', '09:00'), expectEventCount: 0 }],
  },
  {
    matrixRef: 'MissingSlaSweepTests.EmitsFileMissingBySla_AfterDeadline_WhenNothingArrived',
    name: 'nothing arrived',
    config: baseConfig,
    seedStates: [],
    steps: [{ now: day('17', '09:00'), expectEventCount: 1 }],
  },
  {
    matrixRef: 'MissingSlaSweepTests.DoesNotReEmit_SameDay',
    name: 'sentinel idempotency same day',
    config: baseConfig,
    seedStates: [],
    steps: [
      { now: day('17', '09:00'), expectEventCount: 1 },
      { now: day('17', '10:00'), expectEventCount: 0 },
    ],
  },
  {
    matrixRef: 'MissingSlaSweepTests.EmitsAgain_OnLaterDay',
    name: 're-emits next day',
    config: baseConfig,
    seedStates: [],
    steps: [
      { now: day('17', '09:00'), expectEventCount: 1 },
      { now: day('18', '09:00'), expectEventCount: 1 },
    ],
  },
];

// ------------------------------------------------------------------ main ----

async function main(): Promise<void> {
  for (const s of engineScenarios) await runEngineScenario(s);
  for (const s of sweepScenarios) await runSweepScenario(s);

  const vectors = {
    $comment:
      'Generated by apps/watcher/src/parity/generate-vectors.ts by EXECUTING the frozen TS reference engine. ' +
      'Do not hand-edit; regenerate with: npm run parity:vectors -w @apps/watcher. ' +
      'Property-based cases not vectorizable here (BatchIdGeneratorTests.*, EventBuilderTests.GeneratesFreshEventId_EachCall): ' +
      'assert non-empty + unique-per-call directly in C#.',
    generatedAt: T0.toISOString(),
    policy: policyCases,
    rules: ruleVectors,
    interfaceMatcher: matcherVectors,
    engineScenarios,
    sweepScenarios,
  };

  writeFileSync(OUT_PATH, JSON.stringify(vectors, null, 2) + '\n');
  const counts = `${policyCases.length} policy, ${ruleVectors.length} rule, ${matcherVectors.length} matcher, ${engineScenarios.length} engine, ${sweepScenarios.length} sweep`;
  console.log(`OK — all scenarios verified against the reference engine. Wrote ${OUT_PATH} (${counts})`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
