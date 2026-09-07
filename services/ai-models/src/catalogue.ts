import type { Task } from './gbdt';

/*
 * The models this server knows how to fit: what each learns, from which of the records it holds, and the feature sets a
 * version can be fitted on. A model lives in the platform's registry under the same key; the registry owns its
 * governance (validation, approval, deployment) and this catalogue owns only how it is fitted and answered.
 *
 * Nothing here names a real body. The targeting model reads a ship's age, its own history and whether it flies the home
 * flag — never which flag state or which class society, because the world it is fitted on is fictional and a fictional
 * pattern must not be read as a statement about a real registry or a real society.
 */
export interface FeatureDef { name: string; kind: 'num' | 'cat'; description: string }
export interface FeatureSet { name: string; features: string[]; note: string }
export interface ModelDef {
  key: string; task: Task; name: string; description: string;
  /** What the label is, in words, and the unit a regression answers in. */
  label: string; unit?: string;
  features: FeatureDef[];
  /** In order of lineage: the first is the simplest fit, the last is what a new version is fitted on by default. */
  featureSets: FeatureSet[];
}

export const CATALOGUE: ModelDef[] = [
  {
    key: 'inspection-targeting', task: 'CLASSIFICATION', name: 'Port state inspection targeting',
    description: 'The chance that boarding an expected arrival finds a detention or a run of deficiencies, from the ship’s age, how long since it was last boarded, its own record and its type.',
    label: 'The inspection found a detention, or at least the platform’s threshold of deficiencies',
    features: [
      { name: 'shipAgeYears', kind: 'num', description: 'Years since the ship was built, at the inspection' },
      { name: 'daysSinceLastInspection', kind: 'num', description: 'Days since the ship was last boarded here; the median stands in when it never was' },
      { name: 'priorDeficiencies', kind: 'num', description: 'Deficiencies found on the ship’s earlier boardings' },
      { name: 'priorDetentions', kind: 'num', description: 'Earlier detentions of the ship' },
      { name: 'shipType', kind: 'cat', description: 'The ship type' },
      { name: 'homeFlag', kind: 'cat', description: 'Whether the ship flies the home flag' },
    ],
    featureSets: [
      { name: 'baseline', features: ['shipAgeYears', 'daysSinceLastInspection', 'shipType', 'homeFlag'], note: 'First fit on the inspection outcomes: age, time since the last boarding, type and flag' },
      { name: 'history', features: ['shipAgeYears', 'daysSinceLastInspection', 'priorDeficiencies', 'priorDetentions', 'shipType', 'homeFlag'], note: 'Added the ship’s own deficiency and detention history' },
    ],
  },
  {
    key: 'eta-prediction', task: 'REGRESSION', name: 'Arrival time prediction', unit: 'hours',
    description: 'The hours a ship will wait between its reported arrival and its berth, from what is known when the call is announced: the ship, its agent, the hour and day of arrival, the queue ahead, the cargo and where it came from.',
    label: 'Hours from the reported ETA to all fast alongside',
    features: [
      { name: 'shipType', kind: 'cat', description: 'The ship type' },
      { name: 'agentCode', kind: 'cat', description: 'The appointed agent' },
      { name: 'etaHour', kind: 'num', description: 'The hour of the reported ETA on the home port’s clock' },
      { name: 'etaWeekday', kind: 'cat', description: 'The weekday of the reported ETA on the home port’s clock (0 Sunday … 6 Saturday)' },
      { name: 'queueAhead', kind: 'num', description: 'Arrivals expected in the 24 hours before this one' },
      { name: 'teu', kind: 'num', description: 'Containers to be worked, in TEU' },
      { name: 'cargoMt', kind: 'num', description: 'Cargo to be worked, in tonnes' },
      { name: 'prevPort', kind: 'cat', description: 'The previous port of call' },
    ],
    featureSets: [
      { name: 'arrivals', features: ['shipType', 'agentCode', 'etaHour', 'etaWeekday', 'queueAhead', 'teu', 'cargoMt', 'prevPort'], note: 'Fit on the port calls that reached a berth' },
    ],
  },
];

export const modelDef = (key: string): ModelDef | undefined => CATALOGUE.find((m) => m.key === key);
export const featureSetOf = (def: ModelDef, name?: string): FeatureSet | undefined => (name ? def.featureSets.find((f) => f.name === name) : def.featureSets[def.featureSets.length - 1]);
/** The declared kind of every feature in a set, so the learner never has to guess a column's type from its values. */
export const declaredKinds = (def: ModelDef, set: FeatureSet): Record<string, 'num' | 'cat'> =>
  Object.fromEntries(def.features.filter((f) => set.features.includes(f.name)).map((f) => [f.name, f.kind]));
