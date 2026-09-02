import { getJurisdiction } from '@maritime/contracts';

/** Per-profile geography: berth positions, anchorage and the named areas incidents and alerts are placed in. */
export interface WorldGeo { portCode: string; portName: string; berthPos: Record<string, [number, number]>; anchorage: [number, number]; approach: [number, number]; areas: [string, number, number][] }

const grid = (codes: string[], lat0: number, lon0: number, dLat: number, dLon: number): Record<string, [number, number]> =>
  Object.fromEntries(codes.map((c, i) => [c, [Math.round((lat0 + i * dLat) * 1e4) / 1e4, Math.round((lon0 + i * dLon) * 1e4) / 1e4]]));

const AE: WorldGeo = {
  portCode: 'AEAUH', portName: 'Khalifa Port',
  berthPos: {
    ...grid(['CT1-1', 'CT1-2', 'CT3-1', 'CT3-2', 'CT4-1', 'CT4-2', 'CT5-1', 'CT5-2'], 24.8085, 54.6390, 0.0006, 0.0022),
    ...grid(['MP-1', 'MP-2', 'MP-3', 'MP-4'], 24.7990, 54.6300, 0.0007, 0.0018),
    ...grid(['WB-1', 'WB-2', 'WB-3', 'WB-4'], 24.7950, 54.6250, -0.0008, 0.0020),
    ...grid(['LB-1', 'LB-2', 'LB-3', 'LB-4'], 24.7920, 54.6320, 0.0007, 0.0018),
    ...grid(['RR-1', 'RR-2'], 24.8050, 54.6580, 0.0006, 0.0020),
    'SPM-1': [24.7200, 54.5800], 'SPM-2': [24.7150, 54.5950],
  },
  anchorage: [24.9000, 54.5500], approach: [24.8600, 54.6000],
  areas: [['Khalifa Port approach channel', 24.86, 54.60], ['Outer anchorage A1 — Khalifa Port', 24.90, 54.55], ['Fairway buoy sector', 24.88, 54.58], ['Gate complex — Khalifa Port', 24.80, 54.66],
    ['Jebel Ali anchorage', 25.05, 54.98], ['Fujairah anchorage', 25.18, 56.42], ['Mina Zayed basin', 24.52, 54.38], ['Sharjah — Khalid Port approaches', 25.37, 55.37], ['Ras Al Khaimah — Saqr Port approaches', 25.98, 56.03]],
};
const IN: WorldGeo = {
  portCode: 'REFPT', portName: 'Harbour',
  berthPos: {
    ...grid(['CT1-1', 'CT1-2', 'CT3-1', 'CT3-2', 'CT4-1', 'CT4-2', 'CT5-1', 'CT5-2'], 22.7495, 69.7065, 0.0007, 0.0020),
    ...grid(['MP-1', 'MP-2', 'MP-3', 'MP-4'], 22.7435, 69.6990, 0.0007, 0.0018),
    ...grid(['WB-1', 'WB-2', 'WB-3', 'WB-4'], 22.7370, 69.6870, -0.0010, 0.0025),
    ...grid(['LB-1', 'LB-2', 'LB-3', 'LB-4'], 22.7405, 69.6940, 0.0007, 0.0018),
    ...grid(['RR-1', 'RR-2'], 22.7480, 69.7315, 0.0006, 0.0020),
    'SPM-1': [22.6350, 69.6250], 'SPM-2': [22.6280, 69.6420],
  },
  anchorage: [22.6480, 69.7600], approach: [22.5200, 69.5200],
  areas: [['Approach channel', 22.60, 69.55], ['Outer anchorage A1', 22.65, 69.76], ['Fairway buoy sector', 22.62, 69.58], ['Gate complex', 22.75, 69.72], ['Southern approaches', 22.47, 69.55], ['Western shallows', 22.58, 69.50]],
};
export const geoFor = (profile: string): WorldGeo => (getJurisdiction(profile).code === 'AE' ? AE : IN);
