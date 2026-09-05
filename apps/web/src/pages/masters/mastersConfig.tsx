/* One registry drives the whole Data Studio. The masters themselves — their keys, labels, groups and the meta
 * fields each one carries — come from the contract, which is what the mdm service serves and validates; this
 * file only adds what a screen needs and a service does not: an icon and a colour per master. A category the
 * contract gains is a card here on the next build, with a working editor, without a line of screen code. */
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
import GavelRoundedIcon from '@mui/icons-material/GavelRounded';
import CorporateFareRoundedIcon from '@mui/icons-material/CorporateFareRounded';
import WorkspacePremiumRoundedIcon from '@mui/icons-material/WorkspacePremiumRounded';
import SchoolRoundedIcon from '@mui/icons-material/SchoolRounded';
import AssignmentIndRoundedIcon from '@mui/icons-material/AssignmentIndRounded';
import FactCheckRoundedIcon from '@mui/icons-material/FactCheckRounded';
import ExploreRoundedIcon from '@mui/icons-material/ExploreRounded';
import RssFeedRoundedIcon from '@mui/icons-material/RssFeedRounded';
import ListAltRoundedIcon from '@mui/icons-material/ListAltRounded';
import { LOOKUP_CATEGORIES, type LookupMetaField } from '@maritime/contracts';
import type { Column, FieldSpec } from '../../types';

export interface LookupRow { id: string; category: string; code: string; label: string; labelAr?: string | null; meta?: Record<string, any>; active: boolean }
export interface MasterDef { key: string; name: string; nameAr?: string; icon: SvgIconComponent; color: string; desc: string; group: string; system?: boolean; extraColumns?: Column<LookupRow>[]; metaFields?: FieldSpec[] }

type Look = { icon: SvgIconComponent; color: string };
const BY_KEY: Record<string, Look> = {
  country: { icon: PublicRoundedIcon, color: '#0B74B0' }, state: { icon: MapRoundedIcon, color: '#0B74B0' }, city: { icon: LocationCityRoundedIcon, color: '#0B74B0' }, port: { icon: AnchorRoundedIcon, color: '#06737E' },
  uom: { icon: StraightenRoundedIcon, color: '#5A6B78' }, currency: { icon: PaymentsRoundedIcon, color: '#BD3861' }, agent: { icon: SupportAgentRoundedIcon, color: '#2C6E52' },
  vesselType: { icon: DirectionsBoatFilledRoundedIcon, color: '#3B6FB6' }, cargoType: { icon: Inventory2RoundedIcon, color: '#8A5810' }, recognisedOrganisation: { icon: WorkspacePremiumRoundedIcon, color: '#3B6FB6' }, voyageArea: { icon: ExploreRoundedIcon, color: '#3B6FB6' },
  equipmentType: { icon: PrecisionManufacturingRoundedIcon, color: '#75479C' }, equipment: { icon: ConstructionRoundedIcon, color: '#75479C' },
  department: { icon: ApartmentRoundedIcon, color: '#0A2239' }, designation: { icon: BadgeRoundedIcon, color: '#0A2239' }, shift: { icon: ScheduleRoundedIcon, color: '#0A2239' }, holiday: { icon: EventRoundedIcon, color: '#2C6E52' },
  documentType: { icon: FolderRoundedIcon, color: '#8A5A2B' }, incidentArea: { icon: PlaceRoundedIcon, color: '#B3452E' }, deficiencyCode: { icon: RuleRoundedIcon, color: '#8A5810' }, actionCode: { icon: GppMaybeRoundedIcon, color: '#8A5810' }, inspectionRegime: { icon: FactCheckRoundedIcon, color: '#8A5810' },
  accreditationCategory: { icon: WorkspacePremiumRoundedIcon, color: '#2C6E52' }, visitType: { icon: FactCheckRoundedIcon, color: '#2C6E52' }, companyCategory: { icon: CorporateFareRoundedIcon, color: '#2C6E52' },
  seafarerRank: { icon: AssignmentIndRoundedIcon, color: '#75479C' }, metProgramme: { icon: SchoolRoundedIcon, color: '#75479C' }, metInstitutionType: { icon: SchoolRoundedIcon, color: '#75479C' }, imoSource: { icon: RssFeedRoundedIcon, color: '#5A6B78' },
};
const BY_GROUP: Record<string, Look> = {
  Geography: { icon: PublicRoundedIcon, color: '#0B74B0' }, Commercial: { icon: PaymentsRoundedIcon, color: '#BD3861' }, Marine: { icon: DirectionsBoatFilledRoundedIcon, color: '#3B6FB6' },
  'Ship Registry': { icon: AnchorRoundedIcon, color: '#06737E' }, 'Seafarers & MET': { icon: BadgeRoundedIcon, color: '#75479C' }, Legislation: { icon: GavelRoundedIcon, color: '#5A6B78' },
  Industry: { icon: CorporateFareRoundedIcon, color: '#2C6E52' }, Compliance: { icon: RuleRoundedIcon, color: '#8A5810' }, Assets: { icon: ConstructionRoundedIcon, color: '#75479C' }, Organisation: { icon: ApartmentRoundedIcon, color: '#0A2239' },
};
const FALLBACK: Look = { icon: ListAltRoundedIcon, color: '#5A6B78' };

const show = (v: unknown) => (typeof v === 'boolean' ? (v ? 'Yes' : 'No') : v == null || v === '' ? '—' : String(v));
const metaCol = (label: string, path: string): Column<LookupRow> => ({ key: `meta.${path}`, label, render: (r) => show(r.meta?.[path]), exportValue: (r) => (r.meta?.[path] == null ? '' : String(r.meta?.[path])) });
const WIDE = new Set(['address', 'working', 'url', 'reminderDays']);
const toField = (m: LookupMetaField): FieldSpec => ({
  name: m.key, label: m.label, placeholder: m.placeholder, cols: WIDE.has(m.key) ? 12 : undefined,
  type: m.type === 'boolean' ? 'switch' : m.type === 'select' ? 'select' : m.type === 'number' ? 'number' : m.type === 'date' ? 'date' : 'text',
  options: m.type === 'select' ? (m.options ?? []).map((v) => ({ value: v, label: v })) : undefined,
});

export const MASTERS: MasterDef[] = LOOKUP_CATEGORIES.map((c) => ({
  key: c.key, name: c.label, nameAr: c.labelAr, desc: c.desc ?? '', group: c.group, system: c.system,
  ...(BY_KEY[c.key] ?? BY_GROUP[c.group] ?? FALLBACK),
  extraColumns: (c.metaFields ?? []).slice(0, 4).map((m) => metaCol(m.label, m.key)),
  metaFields: (c.metaFields ?? []).map(toField),
}));
export const masterByKey = (key?: string) => MASTERS.find((m) => m.key === key);
