/* What GET /tracking/analytics answers, shaped as the maritime-centre service composes it. */
export interface AnalyticsCell { lat: number; lon: number; ships: number; fixes: number; moving: number; meanSog: number; bearing: number | null; flow: number; categories: Record<string, number> }
export interface AreaDwell { code: string; name: string; kind: string; ships: number; visits: number; hours: number; avgVisitHours: number; longest: { key: string; name: string; hours: number } | null }
export interface DayRow { day: string; ships: number; registered: number; fixes: number; movingPct: number }
export interface AnalyticsData {
  window: { from: string; to: string; days: number }; cellNm: number; grid: { dLat: number; dLon: number };
  kpis: { ships: number; registered: number; fixes: number; movingPct: number; meanSogKn: number; cellsUsed: number; lanes: number; busiestCell: AnalyticsCell | null; busiestArea: AreaDwell | null; areasVisited: number };
  cells: AnalyticsCell[]; lanes: AnalyticsCell[]; areas: AreaDwell[]; byDay: DayRow[]; byCategory: { category: string; ships: number; fixes: number }[]; generatedAt: string;
}
