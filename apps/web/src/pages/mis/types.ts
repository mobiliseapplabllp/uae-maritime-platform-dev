/* MIS API contract — the report library and the monthly MIS report served by the reporting service over its read models. */
export interface ReportParam { name: string; label: string; type: string; default?: unknown }
export interface ReportColumn { key: string; label: string; align?: string }
/** GET /reports/catalog — one saved report definition. */
export interface ReportDef { key: string; name: string; name_ar?: string | null; category: string; description: string; perm: string; params: ReportParam[]; columns: ReportColumn[]; query_key?: string }
export type ReportRow = Record<string, unknown>;
/** GET /reports/run/:key */
export interface ReportRun { report: ReportDef; params: Record<string, string>; rows: ReportRow[]; generatedAt: string; currency?: string }
/** One month of the MIS report. */
export interface MisMonth { key: string; month: string; calls: number; cargoMT: number; teu: number; container: number; dryBulk: number; liquid: number; other: number; avgTurnaroundH: number; avgWaitH: number; revenue: number; collected: number; inspections: number; detentions: number; findings: number; incidents: number; highIncidents: number }
export interface MisTotals { calls: number; cargoMT: number; teu: number; revenue: number; collected: number; inspections: number; detentions: number; incidents: number }
export interface Benchmark { key: string; value: number | number[]; confirmed: boolean; source: string }
/** GET /reports/mis?months= */
export interface MisData { months: number; rows: MisMonth[]; totals: MisTotals; currency: string; benchmarks: Benchmark[]; generatedAt: string }
