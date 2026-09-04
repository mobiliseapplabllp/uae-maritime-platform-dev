/* Shapes returned by the observability service. `detail` is deliberately loose: a service, a
 * database, the broker and a service level each report different things, and forcing them into one
 * flat shape would mean a column that is null for most rows. */

export interface Telemetry {
  service: string; version: string; uptimeSec: number; node: string;
  memory: { rssMb: number; heapUsedMb: number; heapTotalMb: number };
  db: { reachable: boolean; latencyMs: number | null; poolTotal: number; poolIdle: number; poolWaiting: number; error?: string };
  outbox: { unpublished: number; oldestUnpublishedSec: number | null; publishedLastHour: number };
  inbox: { processed: number; lastProcessedAt: string | null };
  migrations: { applied: number; last: string | null; lastAppliedAt: string | null };
}

export interface DatabaseDetail { name: string; sizeMb: number; connections: number }
export interface ConsumerDetail { name: string; pending: number; ackPending: number; redelivered: number }
export interface StreamDetail { name: string; messages: number; bytes: number; consumers: ConsumerDetail[]; maxPending: number }

export interface TargetState {
  target: string;
  kind: 'service' | 'database' | 'broker' | 'sla';
  category: string | null;
  url: string | null;
  up: boolean;
  since: string;
  forSec: number;
  lastSeenAt: string | null;
  lastProbeAt: string;
  latencyMs: number | null;
  uptimeSec: number | null;
  error: string | null;
  detail: {
    kind?: string; port?: number; url?: string;
    telemetry?: Telemetry; telemetryError?: string;
    databases?: DatabaseDetail[]; databaseCount?: number; totalSizeMb?: number; connections?: number; maxConnections?: number; longestQuerySec?: number;
    server?: { version?: string; connections?: number; totalConnections?: number; inMsgs?: number; outMsgs?: number; slowConsumers?: number; memMb?: number };
    jetstream?: { streams: StreamDetail[]; streamCount: number; consumerCount: number; totalPending: number; memoryMb: number; storeMb: number };
    label?: string; domain?: string; path?: string; status?: number; targetMs?: number; withinTarget?: boolean;
  };
}

export interface Incident {
  id: string; target: string; kind: 'outage' | 'restart' | 'degraded';
  startedAt: string; endedAt: string | null; durationSec: number; open: boolean;
  detail: Record<string, unknown>;
}

export interface PlatformStatus {
  generatedAt: string;
  lastSweepAt: string | null;
  tickMs: number;
  summary: { services: number; servicesUp: number; targets: number; targetsUp: number; openIncidents: number; status: 'ok' | 'degraded' | 'down' };
  targets: TargetState[];
  openIncidents: Incident[];
}

export interface AvailabilityRow { target: string; samples: number; upSamples: number; availability: number | null; latencyP50: number | null; latencyP95: number | null; latencyMax: number | null }
export interface HistoryPoint { bucket: string; samples: number; upSamples: number; availability: number | null; latencyP50: number | null; latencyP95: number | null; latencyMax: number | null }
export interface SlaRow { key: string; label: string; domain: string; path: string; targetMs: number; up: boolean | null; latencyMs: number | null; withinTarget: boolean | null; availability24h: number | null; latencyP95: number | null }
