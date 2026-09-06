/* Surveillance API contract — the traffic picture (positions, zones, MDA alerts) served by GET /tracking. */
export type NavStatus = 'MOORED' | 'AT_ANCHOR' | 'UNDERWAY' | 'RESTRICTED';
export interface TrackedVessel { id: string; name: string; imo: string; type?: string; flag?: string; status?: string }
export interface TrackedPosition { id: string; vesselId: string; vessel: TrackedVessel; lat: number; lon: number; course: number; speed: number; navStatus: NavStatus; destination?: string; receivedAt: string; source?: string }
export type AlertType = 'AIS_GAP' | 'SPEED_IN_CHANNEL' | 'ZONE_ENTRY' | 'ANCHOR_DRIFT' | 'CLOSE_QUARTERS';
export interface MdaAlert { id: string; type: AlertType; severity: 'info' | 'warning' | 'error'; vesselId?: string | null; vesselName?: string; vessel?: { id: string; name: string } | null; note?: string; at: string; acknowledged: boolean }
/** Chart features the platform draws instead of map tiles — polygons for land / anchorages / restricted areas, a polyline for a channel, points for SPMs. */
export type ZoneKind = 'LAND' | 'ANCHORAGE' | 'CHANNEL' | 'SPM' | 'RESTRICTED';
export interface TrafficZone { id: string; kind: ZoneKind; label: string; points: { lat: number; lon: number }[] }
export interface SurveillanceThresholds { channelSpeedLimitKn: number; aisGapAlertMin: number; anchorDriftNm: number; zoneEntryWatch: boolean }
export interface TrafficPicture { positions: TrackedPosition[]; alerts: MdaAlert[]; generatedAt: string; coverage: string; port?: { name: string; lat: number; lon: number; zoomKm?: number }; zones?: TrafficZone[]; /** From Harbour Operations → module settings; the derived alerts are judged against these. */ thresholds?: SurveillanceThresholds }
/** GET /incidents?open=true — the open case files plotted on the picture. */
export interface OpenIncident { id: string; number: string; severity: string; position?: { lat: number; lon: number } | null; location?: { lat: number; lon: number } | null }

/* ------------------------------------------------------------------- the map's targets (GET /tracking/targets) --- */
export type TargetCategory = 'cargo' | 'tanker' | 'passenger' | 'highspeed' | 'tug' | 'fishing' | 'pleasure' | 'other';
export interface Target {
  mmsi: string; imo: string; name: string; callSign: string; shipType: number | null; category: TargetCategory; typeLabel: string; flag: string | null;
  lat: number; lon: number; sog: number; cog: number; heading: number | null; navStatus: string; navStatusCode: number | null; destination: string; eta: string;
  draught: number | null; length: number | null; width: number | null; source: string; receivedAt: string; ageMinutes: number; registered: boolean; vesselId: string | null; vesselStatus: string | null;
}
export interface TargetDetail extends Target { following: boolean; alerts: MdaAlert[]; destinationPort: string | null }
export interface TargetCluster { lat: number; lon: number; count: number; categories: Record<string, number> }
export interface TargetsResponse {
  targets: Target[]; clusters: TargetCluster[]; total: number; clustered: boolean; generatedAt: string;
  totals: { all: number; registered: number; freshHour: number }; legend: { key: TargetCategory; label: string }[]; coverage: string; thresholds?: SurveillanceThresholds;
}
export interface TrackPoint { lat: number; lon: number; sog: number; cog: number; receivedAt: string }
export interface TargetTrack { key: string; mmsi: string; hours: number; track: TrackPoint[]; summary: { fixes: number; distanceNm: number; maxSpeedKn: number; avgSpeedKn: number } }
export interface WatchItem { mmsi: string; vesselId: string | null; name: string; addedAt: string | null; target: Target | null }
export interface PortMarker { code: string; name: string; country: string; lat: number; lon: number }
export interface SeaArea { id: string; code: string; name: string; kind: string; alertOn: string; geojson: { type: string; coordinates: number[][][] } }
export interface Layers { ports: PortMarker[]; home: { name: string; code: string; lat: number; lon: number; zoomKm: number }; areas: SeaArea[]; zones: TrafficZone[]; restrictions: TrafficZone[] }
