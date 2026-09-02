/* One registry drives the whole Data Studio: every configuration master with its icon, columns, form and meta mapping. */
import type { SvgIconComponent } from '@mui/icons-material';
import PublicRoundedIcon from '@mui/icons-material/PublicRounded';
import MapRoundedIcon from '@mui/icons-material/MapRounded';
import LocationCityRoundedIcon from '@mui/icons-material/LocationCityRounded';
import StraightenRoundedIcon from '@mui/icons-material/StraightenRounded';
import PaymentsRoundedIcon from '@mui/icons-material/PaymentsRounded';
import PrecisionManufacturingRoundedIcon from '@mui/icons-material/PrecisionManufacturingRounded';
import ConstructionRoundedIcon from '@mui/icons-material/ConstructionRounded';
import ApartmentRoundedIcon from '@mui/icons-material/ApartmentRounded';
import BadgeRoundedIcon from '@mui/icons-material/BadgeRounded';
import ScheduleRoundedIcon from '@mui/icons-material/ScheduleRounded';
import FolderRoundedIcon from '@mui/icons-material/FolderRounded';
import PlaceRoundedIcon from '@mui/icons-material/PlaceRounded';
import EventRoundedIcon from '@mui/icons-material/EventRounded';
import DirectionsBoatFilledRoundedIcon from '@mui/icons-material/DirectionsBoatFilledRounded';
import Inventory2RoundedIcon from '@mui/icons-material/Inventory2Rounded';
import AnchorRoundedIcon from '@mui/icons-material/AnchorRounded';
import SupportAgentRoundedIcon from '@mui/icons-material/SupportAgentRounded';
import RuleRoundedIcon from '@mui/icons-material/RuleRounded';
import GppMaybeRoundedIcon from '@mui/icons-material/GppMaybeRounded';
import type { Column, FieldSpec } from '../../types';

export interface LookupRow { id: string; category: string; code: string; label: string; labelAr?: string | null; meta?: Record<string, any>; active: boolean }
export interface MasterDef { key: string; name: string; icon: SvgIconComponent; color: string; desc: string; group: string; extraColumns?: Column<LookupRow>[]; metaFields?: FieldSpec[] }
const metaCol = (label: string, path: string): Column<LookupRow> => ({ key: `meta.${path}`, label, render: (r) => r.meta?.[path] ?? '—', exportValue: (r) => r.meta?.[path] ?? '' });
const sel = (values: string[]) => values.map((v) => ({ value: v, label: v }));

export const MASTERS: MasterDef[] = [
  { key: 'country', name: 'Countries', icon: PublicRoundedIcon, color: '#0B74B0', desc: 'Trade-lane and registry countries', group: 'Geography' },
  { key: 'state', name: 'Emirates / States', icon: MapRoundedIcon, color: '#0B74B0', desc: 'Administrative regions in the operational footprint', group: 'Geography', extraColumns: [metaCol('Country', 'country')], metaFields: [{ name: 'country', label: 'Country code', placeholder: 'AE' }] },
  { key: 'city', name: 'Cities', icon: LocationCityRoundedIcon, color: '#0B74B0', desc: 'Cities used across addresses and offices', group: 'Geography', extraColumns: [metaCol('Region', 'state'), metaCol('Country', 'country')], metaFields: [{ name: 'state', label: 'Region code', placeholder: 'DXB' }, { name: 'country', label: 'Country code', placeholder: 'AE' }] },
  { key: 'port', name: 'Ports (UN/LOCODE)', icon: AnchorRoundedIcon, color: '#0797A5', desc: 'Trade-lane ports with UN/LOCODEs', group: 'Geography', extraColumns: [metaCol('Country', 'country')], metaFields: [{ name: 'country', label: 'Country' }] },
  { key: 'uom', name: 'Units of Measure', icon: StraightenRoundedIcon, color: '#5A6B78', desc: 'Quantity units used in cargo, tariffs and services', group: 'Commercial' },
  { key: 'currency', name: 'Currencies', icon: PaymentsRoundedIcon, color: '#BD3861', desc: 'Billing currencies', group: 'Commercial', extraColumns: [metaCol('Symbol', 'symbol')], metaFields: [{ name: 'symbol', label: 'Symbol', placeholder: 'AED' }] },
  { key: 'agent', name: 'Shipping Agents', icon: SupportAgentRoundedIcon, color: '#2C6E52', desc: 'Licensed boarding agents with tax registration', group: 'Commercial', extraColumns: [metaCol('Address', 'address'), metaCol('Tax id', 'taxId')], metaFields: [{ name: 'address', label: 'Address', cols: 12 }, { name: 'taxId', label: 'Tax registration (sample)' }] },
  { key: 'vesselType', name: 'Vessel Types', icon: DirectionsBoatFilledRoundedIcon, color: '#3B6FB6', desc: 'Registry vessel classifications', group: 'Marine' },
  { key: 'cargoType', name: 'Cargo Types', icon: Inventory2RoundedIcon, color: '#9C6412', desc: 'Commodity groups with units and MT factors', group: 'Marine', extraColumns: [metaCol('Group', 'group'), metaCol('Unit', 'unit'), metaCol('MT factor', 'mtFactor')],
    metaFields: [{ name: 'group', label: 'Statistical group', type: 'select', options: sel(['container', 'dryBulk', 'liquid', 'breakBulk', 'roro']) }, { name: 'unit', label: 'Unit', placeholder: 'MT / TEU / UNITS' }, { name: 'mtFactor', label: 'MT factor', type: 'number' }] },
  { key: 'equipmentType', name: 'Equipment Types', icon: PrecisionManufacturingRoundedIcon, color: '#75479C', desc: 'Classes of cargo-handling and response equipment', group: 'Assets' },
  { key: 'equipment', name: 'Equipment & Assets', icon: ConstructionRoundedIcon, color: '#75479C', desc: 'The asset register — cranes, conveyors, response kit', group: 'Assets', extraColumns: [metaCol('Type', 'type'), metaCol('Terminal', 'terminal'), metaCol('Status', 'status'), metaCol('Make', 'make')],
    metaFields: [{ name: 'type', label: 'Equipment type code', placeholder: 'STS' }, { name: 'terminal', label: 'Terminal / location' }, { name: 'status', label: 'Status', type: 'select', options: sel(['OPERATIONAL', 'MAINTENANCE', 'OUT_OF_SERVICE']) }, { name: 'make', label: 'Make / model' }] },
  { key: 'department', name: 'Departments', icon: ApartmentRoundedIcon, color: '#0A2239', desc: 'Organisation departments', group: 'Organisation' },
  { key: 'designation', name: 'Designations', icon: BadgeRoundedIcon, color: '#0A2239', desc: 'Designations mapped to departments', group: 'Organisation', extraColumns: [metaCol('Department', 'department')], metaFields: [{ name: 'department', label: 'Department' }] },
  { key: 'shift', name: 'Shifts', icon: ScheduleRoundedIcon, color: '#0A2239', desc: 'Working shifts for terminal and marine crews', group: 'Organisation', extraColumns: [metaCol('Start', 'start'), metaCol('End', 'end')], metaFields: [{ name: 'start', label: 'Start (HH:MM)' }, { name: 'end', label: 'End (HH:MM)' }] },
  { key: 'documentType', name: 'Document Types', icon: FolderRoundedIcon, color: '#8A5A2B', desc: 'Attachment classes for incidents and compliance', group: 'Compliance' },
  { key: 'incidentArea', name: 'Incident Locations', icon: PlaceRoundedIcon, color: '#B3452E', desc: 'Named areas used when logging incidents', group: 'Compliance' },
  { key: 'deficiencyCode', name: 'Deficiency Codes', icon: RuleRoundedIcon, color: '#9C6412', desc: 'PSC deficiency codes with categories', group: 'Compliance', extraColumns: [metaCol('Category', 'category')], metaFields: [{ name: 'category', label: 'Category' }] },
  { key: 'actionCode', name: 'PSC Action Codes', icon: GppMaybeRoundedIcon, color: '#9C6412', desc: 'Action codes applied to survey findings', group: 'Compliance' },
  { key: 'holiday', name: 'Holiday Calendar', icon: EventRoundedIcon, color: '#2C6E52', desc: 'Gazetted holidays — marine operations stay 24×365', group: 'Organisation', extraColumns: [metaCol('Date', 'date')], metaFields: [{ name: 'date', label: 'Date', type: 'date' }, { name: 'working', label: 'Working note', cols: 12 }] },
];
export const masterByKey = (key?: string) => MASTERS.find((m) => m.key === key);
