/* Surveillance API contract — the traffic picture (positions, zones, MDA alerts) served by GET /tracking. */
export type NavStatus = 'MOORED' | 'AT_ANCHOR' | 'UNDERWAY' | 'RESTRICTED';
export interface TrackedVessel { id: string; name: string; imo: string; type?: string; flag?: string; status?: string }
export interface TrackedPosition { id: string; vesselId: string; vessel: TrackedVessel; lat: number; lon: number; course: number; speed: number; navStatus: NavStatus; destination?: string; receivedAt: string; source?: string }
export type AlertType = 'AIS_GAP' | 'SPEED_IN_CHANNEL' | 'ZONE_ENTRY' | 'ANCHOR_DRIFT' | 'CLOSE_QUARTERS';
export interface MdaAlert { id: string; type: AlertType; severity: 'info' | 'warning' | 'error'; vesselId?: string | null; vesselName?: string; vessel?: { id: string; name: string } | null; note?: string; at: string; acknowledged: boolean }
/** Chart features the platform draws instead of map tiles — polygons for land / anchorages / restricted areas, a polyline for a channel, points for SPMs. */
export type ZoneKind = 'LAND' | 'ANCHORAGE' | 'CHANNEL' | 'SPM' | 'RESTRICTED';
export interface TrafficZone { id: string; kind: ZoneKind; label: string; points: { lat: number; lon: number }[] }
export interface TrafficPicture { positions: TrackedPosition[]; alerts: MdaAlert[]; generatedAt: string; coverage: string; port?: { name: string; lat: number; lon: number; zoomKm?: number }; zones?: TrafficZone[] }
/** GET /incidents?open=true — the open case files plotted on the picture. */
export interface OpenIncident { id: string; number: string; severity: string; position?: { lat: number; lon: number } | null; location?: { lat: number; lon: number } | null }
