import { join } from 'node:path';
import { buildWorld, Prng } from '@maritime/world';
import { createDb, runMigrations, withTx } from '@maritime/service-kit';
import { env } from './env';

/** A back-history of notifications so the bell has something to show on first login. */
export async function seedNotifications(databaseUrl: string, profile?: string) {
  const { pool } = createDb(databaseUrl);
  await runMigrations(pool, join(__dirname, '..', 'migrations'));
  const world = buildWorld({ profile }); const rng = new Prng(world.seed + 7);
  const n = await withTx(pool, async (c) => {
    const existing = await c.query<{ n: string }>('SELECT count(*) AS n FROM notifications'); if (Number(existing.rows[0].n) > 0) return 0;
    const recent = world.portCalls.filter((p) => p.status === 'BERTHED' || p.status === 'SAILED').slice(-25);
    let count = 0;
    for (const pc of recent) {
      await c.query('INSERT INTO notifications(title, body, severity, link, audience_perm, source, event_type, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [`${pc.vesselName} ${pc.status === 'BERTHED' ? 'berthed at' : 'sailed from'} ${pc.berthCode ?? 'anchorage'}`, `Call ${pc.vcn} · agent ${pc.agentCode}`, pc.status === 'BERTHED' ? 'success' : 'info', `/port-calls/${pc.id}`, 'portcalls.view', 'ports', 'ports.portcall.berthed', pc.atb ?? pc.eta]); count++;
    }
    for (const v of world.vessels.filter((x) => !x.real).slice(0, 6)) {
      await c.query('INSERT INTO notifications(title, body, severity, link, audience_perm, source, event_type, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [`Certificate expiring: ${v.name}`, `${rng.pick(['Safety Equipment', 'Load Line', 'IOPP', 'Safety Management'])} certificate expires within 30 days`, 'warning', `/vessels/${v.id}`, 'certificates.view', 'scheduler', 'scheduler.job.completed', new Date(Date.now() - rng.int(1, 200) * 3600000).toISOString()]); count++;
    }
    return count;
  });
  await pool.end();
  return { notifications: n, profile: world.profile };
}
if (require.main === module) { const e = env(); seedNotifications(e.DATABASE_URL).then((c) => console.log('SEED COMPLETE', c)).catch((err) => { console.error(err); process.exit(1); }); }
