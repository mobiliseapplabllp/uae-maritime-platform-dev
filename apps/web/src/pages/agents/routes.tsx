/* AI Agent Operations routes — the console, the append-only decision register, the human queue and the assurance
 * reports. `agents.view` reads; configuring and reviewing are checked inside the pages that offer those actions. */
import { lazy } from 'react';
import type { RouteDef } from '../../routes';

const L = (f: () => Promise<{ default: React.ComponentType<any> }>) => { const C = lazy(f); return <C />; };

export const routes: RouteDef[] = [
  { path: '/agents', perm: 'agents.view', element: L(() => import('./AgentOperations')) },
  { path: '/agents/decisions', perm: 'agents.view', element: L(() => import('./DecisionRegister')) },
  { path: '/agents/escalations', perm: 'agents.view', element: L(() => import('./EscalationQueue')) },
  { path: '/agents/assurance', perm: 'agents.view', element: L(() => import('./Assurance')) },
];
