import { ROLE_CATALOGUE, type TenancyScope } from '@maritime/contracts';
import { Prng, H, stableId } from './prng';

export interface WorldUser {
  id: string; name: string; email: string; roleName: string; designation: string; department: string; phone: string;
  login: boolean; active: boolean; lastLoginAt: string | null;
  /** What this account may see. Absent is the administration's own staff, who see the whole register. */
  scope?: TenancyScope;
}

/* The industry logins, and the company each of them belongs to. An agent is not a member of the
 * administration: they lodge their own calls, see their own invoices, and nothing of anyone else's — which
 * is the tenancy rule the registers enforce, and it only means anything if an account actually carries it. */
const ACCOUNT_SCOPES: Record<string, TenancyScope> = {
  'agent@maritime.example': { level: 'COMPANY', companies: ['GSS'] },
  // A manning agency is the other kind of external tenant, and a different one on purpose: a shipping agent
  // is scoped to the calls and invoices they lodge, a manning agent to the seafarers they placed. The two see
  // disjoint registers, which is what makes the partition worth demonstrating with two accounts rather than one.
  'crewing@maritime.example': { level: 'COMPANY', companies: ['MCA'] },
};
/* The administration's own containment scopes, which are a property of the jurisdiction: a second port's harbour
 * master reads that port's calls and the whole ship register; a terminal supervisor reads one facility, contained to
 * the port it stands in. Neither existed before, so the port and facility levels were enforced but never exercised. */
const CONTAINMENT_SCOPES: Record<string, Record<string, TenancyScope>> = {
  AE: { 'portofficer@maritime.example': { level: 'PORT', ports: ['AEFJR'] }, 'terminal@maritime.example': { level: 'FACILITY', facilities: ['CT3-1'], ports: ['AEAUH'] } },
  IN: { 'portofficer@maritime.example': { level: 'PORT', ports: ['INMRM'] }, 'terminal@maritime.example': { level: 'FACILITY', facilities: ['CT3-1'], ports: ['INNSA'] } },
};
const scopeFor = (email: string, profile: string): TenancyScope | undefined => ACCOUNT_SCOPES[email] ?? CONTAINMENT_SCOPES[profile]?.[email] ?? CONTAINMENT_SCOPES.AE[email];

const LOGIN_USERS: Record<string, [string, string, string, string][]> = {
  AE: [
    ['Ashish Sharma', 'admin@maritime.example', 'Super Admin', 'Platform Administrator'],
    ['Capt. Khalid Al Mansoori', 'harbour@maritime.example', 'Harbour Master', 'Harbour Master'],
    ['Cdr. Saeed Al Hammadi', 'surveyor@maritime.example', 'Marine Surveyor', 'Chief Marine Surveyor'],
    ['Mariam Al Shamsi', 'finance@maritime.example', 'Finance Officer', 'Manager — Billing'],
    ['Rakesh Nair (Gulf Star Shipping)', 'agent@maritime.example', 'Shipping Agent', 'Boarding Agent'],
    ['Sameera Haddad (Maritime Crewing Associates)', 'crewing@maritime.example', 'Manning Agent', 'Crewing Manager'],
    ['Vinod Menon', 'ops2@maritime.example', 'Harbour Master', 'Dy. Harbour Master'],
    ['Lt. Noura Al Zaabi', 'nmc@maritime.example', 'NMC Duty Officer', 'Duty Officer — Maritime Centre'],
    // A model version may not be approved by whoever created it, so somebody other than the administrator
    // has to be able to approve one. Without this account the gate is unsatisfiable and no new model
    // version can ever reach production.
    ['Dr. Hessa Al Suwaidi', 'aigov@maritime.example', 'AI Governance', 'Chair — AI Governance Committee'],
    // The second administrator: approves the privileged grants the Super Admin asks for, and vice versa.
    ['Noora Al Ketbi', 'idadmin@maritime.example', 'Identity Administrator', 'Identity & Access Administrator'],
    ['Capt. Salem Al Dhanhani', 'portofficer@maritime.example', 'Harbour Master', 'Harbour Master — Fujairah'],
    ['Mohammed Al Blooshi', 'terminal@maritime.example', 'Terminal Supervisor', 'Shift Supervisor — Container Terminal 3'],
  ],
  IN: [
    ['Ashish Sharma', 'admin@maritime.example', 'Super Admin', 'Port Administrator'],
    ['Capt. Rajiv Nair', 'harbour@maritime.example', 'Harbour Master', 'Harbour Master'],
    ['Cdr. Suresh Patel', 'surveyor@maritime.example', 'Marine Surveyor', 'Chief Marine Surveyor'],
    ['Meenakshi Iyer', 'finance@maritime.example', 'Finance Officer', 'Manager — Billing'],
    ['Kalpesh Bhatt (Harbour Shipping)', 'agent@maritime.example', 'Shipping Agent', 'Boarding Agent'],
    ['Sunita Deshpande (Maritime Crewing Associates)', 'crewing@maritime.example', 'Manning Agent', 'Crewing Manager'],
    ['Vinod Menon', 'ops2@maritime.example', 'Harbour Master', 'Dy. Harbour Master'],
    ['Lt. Aditi Rathore', 'nmc@maritime.example', 'NMC Duty Officer', 'Duty Officer — Surveillance Centre'],
    ['Dr. Anjali Deshmukh', 'aigov@maritime.example', 'AI Governance', 'Chair — AI Governance Committee'],
    ['Priya Raghavan', 'idadmin@maritime.example', 'Identity Administrator', 'Identity & Access Administrator'],
    ['Capt. Vikram Sardesai', 'portofficer@maritime.example', 'Harbour Master', 'Harbour Master — Mormugao'],
    ['Prakash Salunkhe', 'terminal@maritime.example', 'Terminal Supervisor', 'Shift Supervisor — Container Terminal 3'],
  ],
};
const STAFF: Record<string, [string, string, string][]> = {
  AE: [
    ['Capt. Omar Al Suwaidi', 'Dock Master — West Basin', 'Harbour Master'], ['Capt. Fatima Al Marzooqi', 'Senior Pilot', 'Harbour Master'],
    ['Capt. Arjun Jadeja', 'Pilot', 'Harbour Master'], ['Capt. Farooq Bukhari', 'Pilot', 'Harbour Master'], ['Capt. Hamad Al Nuaimi', 'Dy. Conservator', 'Harbour Master'],
    ['Nilesh Gohil', 'Berth Planner', 'Harbour Master'], ['Ketan Maheshwari', 'Terminal Duty Manager — CT-3', 'Harbour Master'],
    ['Ravindra Ahir', 'Jetty Supervisor — Liquid Terminal', 'Harbour Master'], ['Salim Al Balushi', 'Foreman — Multipurpose', 'Harbour Master'],
    ['Heena Chudasama', 'Marine Control Room Operator', 'NMC Duty Officer'], ['Lt. Sultan Al Kaabi', 'Duty Officer — Surveillance', 'NMC Duty Officer'],
    ['Harshad Mange', 'PFSO Office — ISPS', 'NMC Duty Officer'], ['Dr. Aisha Al Hosani', 'Chief — HSE & Fire', 'Marine Surveyor'],
    ['Jaydeep Rathod', 'HSE Officer', 'Marine Surveyor'], ['Bhavna Joshi', 'Environment Officer', 'Marine Surveyor'], ['Sanjay Vaghela', 'Fire Station Officer', 'Marine Surveyor'],
    ['Yousef Al Ameri', 'Surveyor', 'Marine Surveyor'], ['Lt. Rakesh Joshi', 'Asst. Surveyor', 'Marine Surveyor'],
    ['Anjali Deshmukh', 'Legal Officer — Regulatory Affairs', 'Legal Officer'], ['Farid Al Suwaidi', 'Director — Regulatory Approvals', 'Approver'],
    ['Deepa Krishnamurthy', 'Asst. Manager — Billing', 'Finance Officer'], ['Rohan Trivedi', 'Collections Officer', 'Finance Officer'], ['Nikita Parmar', 'MIS Analyst', 'Finance Officer'],
    ['Abdullah Al Mazrouei', 'Registrar of Ships', 'Registrar of Ships'],
  ],
  IN: [
    ['Capt. Pradeep Chauhan', 'Dock Master — West Basin', 'Harbour Master'], ['Capt. Meera Krishnan', 'Senior Pilot', 'Harbour Master'],
    ['Capt. Arjun Jadeja', 'Pilot', 'Harbour Master'], ['Capt. Farooq Bukhari', 'Pilot', 'Harbour Master'], ['Capt. Devraj Sodha', 'Dy. Conservator', 'Harbour Master'],
    ['Nilesh Gohil', 'Berth Planner', 'Harbour Master'], ['Ketan Maheshwari', 'Terminal Duty Manager — CT-3', 'Harbour Master'],
    ['Ravindra Ahir', 'Jetty Supervisor — Liquid Terminal', 'Harbour Master'], ['Prakash Koli', 'Foreman — Multipurpose', 'Harbour Master'],
    ['Heena Chudasama', 'Marine Control Room Operator', 'NMC Duty Officer'], ['Lt. Vikram Solanki', 'Duty Officer — Surveillance', 'NMC Duty Officer'],
    ['Harshad Mange', 'PFSO Office — ISPS', 'NMC Duty Officer'], ['Dr. Kavita Raval', 'Chief — HSE & Fire', 'Marine Surveyor'],
    ['Jaydeep Rathod', 'HSE Officer', 'Marine Surveyor'], ['Bhavna Joshi', 'Environment Officer', 'Marine Surveyor'], ['Sanjay Vaghela', 'Fire Station Officer', 'Marine Surveyor'],
    ['Narendra Shah', 'Surveyor', 'Marine Surveyor'], ['Lt. Rakesh Joshi', 'Asst. Surveyor', 'Marine Surveyor'],
    ['Anjali Deshmukh', 'Legal Officer — Regulatory Affairs', 'Legal Officer'], ['Farid Al Suwaidi', 'Director — Regulatory Approvals', 'Approver'],
    ['Deepa Krishnamurthy', 'Asst. Manager — Billing', 'Finance Officer'], ['Rohan Trivedi', 'Collections Officer', 'Finance Officer'], ['Nikita Parmar', 'MIS Analyst', 'Finance Officer'],
    ['Suresh Kamath', 'Registrar of Ships', 'Registrar of Ships'],
  ],
};
const FIRST: Record<string, string[]> = {
  AE: ['Ahmed', 'Mohammed', 'Saif', 'Rashid', 'Hamdan', 'Majid', 'Tariq', 'Faisal', 'Salem', 'Khalifa', 'Nasser', 'Hessa', 'Latifa', 'Shamma', 'Alia', 'Reem', 'Amna', 'Maitha', 'Sara', 'Hind',
    'Amit', 'Bhavesh', 'Darshan', 'Gaurav', 'Kalpana', 'Mahesh', 'Pooja', 'Rajan', 'Sanjana', 'Tejas', 'Nour', 'Rami', 'Lina', 'Omar', 'Yara', 'Zaid', 'Hana', 'Karim', 'Dana', 'Bilal',
    'Joseph', 'Maria', 'Ravi', 'Priya', 'Arun', 'Anita', 'Farah', 'Hassan', 'Layla', 'Samir', 'Nadia', 'Imran'],
  IN: ['Amit', 'Bhavesh', 'Chirag', 'Darshan', 'Falguni', 'Gaurav', 'Hardik', 'Ilesh', 'Jignesh', 'Kalpana', 'Lalit', 'Mahesh', 'Naresh', 'Om', 'Parth', 'Rajan', 'Sanjana', 'Tejas', 'Umesh', 'Vandana', 'Yash', 'Zarna', 'Ankit', 'Bhumika', 'Chetan', 'Dhruv',
    'Esha', 'Firoz', 'Gopal', 'Hetal', 'Ishita', 'Jay', 'Kiran', 'Lakshmi', 'Mitali', 'Nirav', 'Pooja', 'Rasik', 'Snehal', 'Tarun', 'Urvashi', 'Vipul', 'Alpesh', 'Bharti', 'Dinesh', 'Hansa', 'Jatin', 'Kamlesh', 'Mayur', 'Nita', 'Pankaj', 'Rekha'],
};
const LAST: Record<string, string[]> = {
  AE: ['Al Mansoori', 'Al Hammadi', 'Al Shamsi', 'Al Zaabi', 'Al Suwaidi', 'Al Marzooqi', 'Al Nuaimi', 'Al Balushi', 'Al Kaabi', 'Al Hosani', 'Al Ameri', 'Al Mazrouei', 'Al Qubaisi', 'Al Dhaheri', 'Al Blooshi',
    'Patel', 'Nair', 'Menon', 'Sharma', 'Khan', 'Haddad', 'Saleh', 'Youssef', 'Farouk', 'Abbas', 'Fernandes', 'D\'Souza', 'Reddy', 'Iyer', 'Rahman', 'Siddiqui', 'Mirza', 'Hussain', 'Aziz', 'Karim'],
  IN: ['Patel', 'Shah', 'Chauhan', 'Gohil', 'Jadeja', 'Rathod', 'Solanki', 'Vaghela', 'Parmar', 'Chudasama', 'Ahir', 'Rabari', 'Maheshwari', 'Trivedi', 'Joshi', 'Dave', 'Mehta', 'Bhatt', 'Vyas', 'Raval', 'Thakkar', 'Gandhi', 'Koli', 'Manek', 'Sama', 'Baraiya',
    'Jethwa', 'Gadhvi', 'Mistry', 'Tandel', 'Chavda', 'Makwana', 'Zala', 'Dodiya', 'Sarvaiya', 'Vala'],
};
const DEPTS: [string, [string, string][], number][] = [
  ['Marine Operations', [['Asst. Harbour Master', 'Harbour Master'], ['Berth Planner', 'Harbour Master'], ['Marine Officer', 'Harbour Master'], ['VTS Operator', 'NMC Duty Officer']], 12],
  ['Pilotage', [['Pilot', 'Port Pilot']], 6],
  ['HSE & Fire', [['HSE Officer', 'HSE Officer'], ['Fire Officer', 'HSE Officer'], ['Environment Officer', 'HSE Officer'], ['Safety Steward', 'HSE Officer']], 12],
  ['Terminal Operations', [['Terminal Supervisor', 'Terminal Supervisor'], ['Shift In-charge', 'Terminal Supervisor'], ['Yard Planner', 'Terminal Supervisor'], ['Tally In-charge', 'Terminal Supervisor']], 22],
  ['Engineering & Maintenance', [['Maintenance Engineer', 'Terminal Supervisor'], ['Electrical Engineer', 'Terminal Supervisor'], ['Crane Technician', 'Terminal Supervisor']], 10],
  ['Finance & Billing', [['Billing Clerk', 'Billing Clerk'], ['Accounts Officer', 'Finance Officer'], ['Collections Executive', 'Billing Clerk']], 8],
  ['Commercial & Marketing', [['Commercial Executive', 'Management Viewer'], ['Key Account Manager', 'Management Viewer']], 5],
  ['Security & ISPS', [['Security Officer', 'Security Officer'], ['Gate Supervisor', 'Security Officer'], ['Port Police Liaison', 'Security Officer']], 10],
  ['Surveys & Compliance', [['Surveyor', 'Marine Surveyor'], ['Compliance Auditor', 'Marine Surveyor']], 6],
  ['IT & Systems', [['Systems Engineer', 'Management Viewer']], 3],
  ['Human Resources', [['HR Executive', 'Management Viewer']], 3],
  ['Stores & Procurement', [['Stores Officer', 'Management Viewer']], 3],
];
const emailOf = (n: string) => `${n.toLowerCase().replace(/\(.*\)/, '').replace(/^(capt|cdr|lt|dr)\.? /, '').trim().replace(/[^a-z]+/g, '.').replace(/^\.|\.$/g, '')}@maritime.example`;
const phoneOf = (profile: string, i: number) => profile === 'AE' ? `+971 5${String(0 + (i % 9))} ${String(1000000 + i * 3517).slice(0, 3)} ${String(1000000 + i * 3517).slice(3, 7)}` : `+91 98${String(79210000 + i * 3517).slice(0, 8)}`;
const deptOfRole = (role: string) => ({ 'Harbour Master': 'Marine Operations', 'NMC Duty Officer': 'Marine Operations', 'Marine Surveyor': 'Surveys & Compliance', 'Legal Officer': 'Legal & Regulatory', Approver: 'Legal & Regulatory', 'Finance Officer': 'Finance & Billing', 'Registrar of Ships': 'Ship Registry', 'Super Admin': 'IT & Systems', 'Identity Administrator': 'IT & Systems', 'Terminal Supervisor': 'Terminal Operations', 'Shipping Agent': 'External', 'Manning Agent': 'External' } as Record<string, string>)[role] ?? 'General';

/** The profile name pools, shared with every generator that names a person (crew, craft masters, contacts). */
export const NAME_POOLS: Record<string, { first: string[]; last: string[] }> = { AE: { first: FIRST.AE, last: LAST.AE }, IN: { first: FIRST.IN, last: LAST.IN } };
export const personName = (rng: Prng, profile: string): string => { const p = NAME_POOLS[profile] ?? NAME_POOLS.AE; return `${rng.pick(p.first)} ${rng.pick(p.last)}`; };
export const usersByRole = (users: WorldUser[], role: string): WorldUser[] => users.filter((u) => u.roleName === role);
export const userNamed = (users: WorldUser[], needle: RegExp): WorldUser | undefined => users.find((u) => needle.test(u.name) || needle.test(u.designation));

export function buildPeople(rng: Prng, profile: string, now: Date): WorldUser[] {
  const p = LOGIN_USERS[profile] ? profile : 'AE';
  const out: WorldUser[] = [];
  const used = new Set<string>();
  const push = (u: Omit<WorldUser, 'id'>) => { if (used.has(u.email)) return; used.add(u.email); out.push({ id: stableId('user', u.email), ...u }); };
  LOGIN_USERS[p].forEach(([name, email, roleName, designation], i) => push({ name, email, roleName, designation, department: deptOfRole(roleName), phone: phoneOf(p, i), login: true, active: true, scope: scopeFor(email, p), lastLoginAt: new Date(now.getTime() - rng.int(1, 40) * H).toISOString() }));
  STAFF[p].forEach(([name, designation, roleName], i) => push({ name, email: emailOf(name), roleName, designation, department: deptOfRole(roleName), phone: phoneOf(p, i + 10), login: false, active: true, lastLoginAt: rng.chance(0.9) ? new Date(now.getTime() - rng.int(1, 900) * H).toISOString() : null }));
  let gi = 0;
  for (const [dept, desigs, count] of DEPTS) {
    for (let k = 0; k < count; k++) {
      const name = `${FIRST[p][gi % FIRST[p].length]} ${LAST[p][(gi * 7 + Math.floor(gi / FIRST[p].length)) % LAST[p].length]}`;
      let email = emailOf(name); let n2 = 2;
      while (used.has(email)) { email = emailOf(name).replace('@', `${n2}@`); n2 += 1; }
      const [designation, roleName] = desigs[k % desigs.length];
      push({ name, email, roleName, designation, department: dept, phone: phoneOf(p, gi + 40), login: false, active: rng.chance(0.96), lastLoginAt: rng.chance(0.8) ? new Date(now.getTime() - rng.int(1, 1200) * H).toISOString() : null });
      gi += 1;
    }
  }
  for (const u of out) if (!ROLE_CATALOGUE.some((r) => r.name === u.roleName)) throw new Error(`unknown role ${u.roleName}`);
  return out;
}
