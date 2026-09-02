import { Controller, Get, Inject } from '@nestjs/common';
import type { Pool } from 'pg';
import { KIT_POOL, RequirePerm } from '@maritime/service-kit';
import { CARGO_GROUP, D, H, certStatus, many, monthKey, months12 } from './queries';

interface CallRow { id: string; vcn: string; vessel_id: string; vessel_name: string; vessel_type: string | null; status: string; eta: Date; etd: Date | null; ata: Date | null; atb: Date | null; atd: Date | null; berth_id: string | null; berth_code: string | null; agent_name: string | null; cargo_ops: { cargoType: string; qty: number; unit: string; qtyMT: number }[] }
interface BerthRow { id: string; code: string; name: string; terminal: string; berth_type: string; status: string; loa_max: string | null; draft_max: string | null }

/** The command-centre payload: KPIs, throughput and revenue series, cargo mix, berth board, arrivals, certificate alerts and recent activity. */
@Controller()
export class DashboardController {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool) {}

  @RequirePerm('dashboard.view') @Get('dashboard')
  async summary() {
    const now = new Date();
    const start12 = new Date(now.getFullYear(), now.getMonth() - 11, 1);
    const startMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startYear = new Date(now.getFullYear(), 0, 1);
    const [berths, active, sailed12, invoices12, certs, inspections, recent] = await Promise.all([
      many<BerthRow>(this.pool, 'SELECT * FROM rm_berths ORDER BY terminal, code'),
      many<CallRow>(this.pool, "SELECT * FROM rm_port_calls WHERE status IN ('ANNOUNCED','CONFIRMED','AT_ANCHORAGE','BERTHED') ORDER BY eta"),
      many<CallRow>(this.pool, "SELECT * FROM rm_port_calls WHERE status = 'SAILED' AND atd >= $1", [start12]),
      many<{ total: string; issued_at: Date | null; created_at: Date }>(this.pool, "SELECT total, issued_at, created_at FROM rm_invoices WHERE status IN ('ISSUED','PAID') AND COALESCE(issued_at, created_at) >= $1", [start12]),
      many<{ vessel_id: string; vessel: string; imo: string; cert_type: string; expiry_date: Date }>(this.pool, "SELECT c.vessel_id, v.name AS vessel, v.imo, c.cert_type, c.expiry_date FROM rm_vessel_certificates c JOIN rm_vessels v ON v.id = c.vessel_id WHERE v.status = 'ACTIVE'"),
      many<{ status: string; detention: boolean; closed_at: Date | null; open_findings: number }>(this.pool, "SELECT status, detention, closed_at, open_findings FROM rm_inspections WHERE status <> 'CLOSED' OR closed_at >= $1", [startYear]),
      many<{ at: Date; actor_name: string | null; action: string; entity: string; entity_label: string | null }>(this.pool, 'SELECT at, actor_name, action, entity, entity_label FROM rm_audit_activity ORDER BY at DESC LIMIT 10'),
    ]);
    const berthed = active.filter((c) => c.status === 'BERTHED');
    const anchored = active.filter((c) => c.status === 'AT_ANCHORAGE');
    const expected72 = active.filter((c) => ['ANNOUNCED', 'CONFIRMED'].includes(c.status) && c.eta > now && c.eta <= new Date(now.getTime() + 72 * H));
    const operational = berths.filter((b) => b.status === 'OPERATIONAL');
    const occupied = new Set(berthed.map((c) => c.berth_id).filter(Boolean));
    const sailed30 = sailed12.filter((c) => c.atd && c.ata && c.atd >= new Date(now.getTime() - 30 * D));
    const avgTurnaround = sailed30.length ? sailed30.reduce((s, c) => s + (c.atd!.getTime() - c.ata!.getTime()), 0) / sailed30.length / H : 0;
    const mtd = sailed12.filter((c) => c.atd && c.atd >= startMonth);
    const cargoMTD = mtd.reduce((s, c) => s + c.cargo_ops.reduce((x, o) => x + (o.qtyMT || 0), 0), 0);
    const teuMTD = mtd.reduce((s, c) => s + c.cargo_ops.filter((o) => o.unit === 'TEU').reduce((x, o) => x + o.qty, 0), 0);
    const revenueMTD = invoices12.filter((i) => (i.issued_at ?? i.created_at) >= startMonth).reduce((s, i) => s + Number(i.total), 0);
    const openDeficiencies = inspections.reduce((s, i) => s + Number(i.open_findings), 0);
    const detentionsYTD = inspections.filter((i) => i.detention && i.closed_at && i.closed_at >= startYear).length;
    const expiring = certs.map((c) => ({ vesselId: c.vessel_id, vessel: c.vessel, imo: c.imo, certType: c.cert_type, expiryDate: c.expiry_date, status: certStatus(c.expiry_date, now) })).filter((c) => c.status !== 'VALID').sort((a, b) => new Date(a.expiryDate).getTime() - new Date(b.expiryDate).getTime());
    const months = months12(now);
    const throughputByMonth = months.map((m) => ({ month: m.label, key: m.key, container: 0, dryBulk: 0, liquid: 0, other: 0, total: 0 }));
    const mix: Record<string, number> = {};
    for (const c of sailed12) {
      const row = throughputByMonth.find((r) => r.key === monthKey(c.atd!));
      for (const o of c.cargo_ops) { const grp = CARGO_GROUP[o.cargoType] || 'other'; const mt = o.qtyMT || 0; if (row) { row[grp] += mt; row.total += mt; } mix[o.cargoType] = (mix[o.cargoType] || 0) + mt; }
    }
    const revenueByMonth = months.map((m) => ({ month: m.label, key: m.key, revenue: 0 }));
    for (const i of invoices12) { const row = revenueByMonth.find((r) => r.key === monthKey(new Date(i.issued_at ?? i.created_at))); if (row) row.revenue += Number(i.total); }
    const berthBoard = berths.map((b) => { const call = berthed.find((c) => c.berth_id === b.id); return { id: b.id, code: b.code, name: b.name, terminal: b.terminal, berthType: b.berth_type, status: b.status, loaMax: Number(b.loa_max), draftMax: Number(b.draft_max), occupiedBy: call ? { callId: call.id, vcn: call.vcn, vessel: call.vessel_name, etd: call.etd, atb: call.atb } : null }; });
    const arrivals = active.filter((c) => ['ANNOUNCED', 'CONFIRMED', 'AT_ANCHORAGE'].includes(c.status)).slice(0, 8).map((c) => ({ id: c.id, vcn: c.vcn, vessel: c.vessel_name, type: c.vessel_type, status: c.status, eta: c.eta, agentName: c.agent_name }));
    return {
      kpis: { vesselsAtBerth: berthed.length, atAnchorage: anchored.length, expectedArrivals72h: expected72.length, berthOccupancyPct: operational.length ? Math.round((occupied.size / operational.length) * 100) : 0, avgTurnaroundHrs: Math.round(avgTurnaround * 10) / 10, cargoMTD, teuMTD, revenueMTD, openDeficiencies, detentionsYTD, certsExpiring: expiring.filter((c) => c.status === 'EXPIRING').length, certsExpired: expiring.filter((c) => c.status === 'EXPIRED').length },
      throughputByMonth, revenueByMonth, cargoMix: Object.entries(mix).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value),
      berthBoard, arrivals, expiringCerts: expiring.slice(0, 8),
      recentActivity: recent.map((a) => ({ at: a.at, actor: a.actor_name, action: a.action, entity: a.entity, label: a.entity_label })),
    };
  }
}
