/* Compliance & risk engine API contract — the shapes the inspection service returns for the risk screens. */
export type RiskBand = 'LOW' | 'MEDIUM' | 'HIGH';
/** The six policy-weighted factors of the model. Weights are settings; every change is audited and versioned. */
export type RiskFactorKey = 'age' | 'certificates' | 'deficiencies' | 'detentions' | 'inspectionGap' | 'agentPerformance';
export type RiskWeights = Record<RiskFactorKey, number>;
/** One named factor of a score — every point traces to a record, so `evidence` is always a sentence a surveyor can check. */
export interface RiskFactor { key: string; label: string; points: number; max: number; evidence: string }
/** One row of GET /risk/scores — an active vessel with its live, factor-decomposed score. Factors arrive sorted by points, highest first. */
export interface RiskScoreRow { vesselId: string; name: string; imo: string; type: string; flag: string; built?: number; agent?: string; score: number; band: RiskBand; factors: RiskFactor[] }
/** `meta` of GET /risk/scores. */
export interface RiskScoresMeta { weights: RiskWeights; computedAt: string }
/** One row of GET /risk/targeting — a call in port or inbound, joined to its vessel's score and ordered by risk. */
export interface TargetingRow { callId: string; vcn: string; status: string; eta: string; berth?: string | null; vessel: string; vesselId: string; risk: RiskScoreRow }
