import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { Chip, Stack, Button, Typography, Box, Divider, Alert, AlertTitle, IconButton, Tooltip, Link } from '@mui/material';
import TaskAltRoundedIcon from '@mui/icons-material/TaskAltRounded';
import CampaignRoundedIcon from '@mui/icons-material/CampaignRounded';
import ContentCopyRoundedIcon from '@mui/icons-material/ContentCopyRounded';
import PublicRoundedIcon from '@mui/icons-material/PublicRounded';
import OpenInNewRoundedIcon from '@mui/icons-material/OpenInNewRounded';
import api from '../../api/client';
import { useAppDispatch, useAppSelector, useUser } from '../../store';
import { notify } from '../../store/uiSlice';
import CrudPage from '../../components/common/CrudPage';
import FormDrawer from '../../components/common/FormDrawer';
import StatusChip from '../../components/common/StatusChip';
import { useLookups } from '../../hooks/useLookups';
import { INSTRUMENT_STATUS_META } from '../../utils/status';
import { fmtD, toInputD } from '../../utils/format';
import { MONO } from '../../theme';
import { STATUS_OPTIONS, TYPE_LOOKUP, approvalVerdict, canAcknowledge, hasAcknowledged, lawPath, portalAbsence } from './shared';
import type { LegalInstrument, PendingNotice } from './types';

/* The notice library — acts, rules, circulars, notices, orders and conventions, with organisation-wide acknowledgments and maker-checker publication.
 * The types come from the `legalInstrumentType` master, which also says which of them the public portal cites. */
const ENDPOINT = '/legislation/instruments';

export default function LegislationPage() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate();
  const user = useUser();
  const lang = useAppSelector((s) => s.ui.lang);
  const { t } = useTranslation();
  const types = useLookups(TYPE_LOOKUP);
  const [reading, setReading] = useState<LegalInstrument | null>(null);
  const [pending, setPending] = useState<PendingNotice[]>([]);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const uid = String(user?.id);
  const err = (e: Error) => dispatch(notify({ message: e.message, severity: 'error' }));

  useEffect(() => { api.get<PendingNotice[]>('/notices/pending', { headers: { 'X-Quiet': '1' } }).then((r) => setPending(r.data)).catch(() => setPending([])); }, [refresh]);

  const bump = () => setRefresh((x) => x + 1);
  /** The register row is a summary; the reading pane wants the full record with its links and its portal address. */
  const open = (row: Pick<LegalInstrument, 'id'> & Partial<LegalInstrument>) => api.get<LegalInstrument>(`${ENDPOINT}/${row.id}`).then((r) => setReading(r.data)).catch(() => setReading(row as LegalInstrument));
  const publish = (row: LegalInstrument) => {
    setBusy(true);
    api.post<LegalInstrument>(`${ENDPOINT}/${row.id}/publish`).then((r) => { dispatch(notify(t('legislation.putInForceDone'))); setReading(r.data); bump(); }).catch(err).finally(() => setBusy(false));
  };
  const acknowledge = (row: LegalInstrument) => {
    setBusy(true);
    api.post<LegalInstrument>(`/notices/${row.id}/acknowledge`).then((r) => { dispatch(notify(t('legislation.acknowledgedDone'))); setReading(r.data); bump(); }).catch(err).finally(() => setBusy(false));
  };
  const copy = (text: string) => { void navigator.clipboard?.writeText(text).then(() => dispatch(notify(t('legislation.portal.copied')))); };
  const verdict = reading ? approvalVerdict(reading, user) : null;
  const title = (r: LegalInstrument) => (lang === 'ar' && r.titleAr ? r.titleAr : r.title);
  const absence = reading ? portalAbsence(reading) : null;

  return (
    <>
      {pending.length > 0 && (
        <Alert severity="warning" icon={<CampaignRoundedIcon fontSize="inherit" />} sx={{ mb: 2 }}>
          <AlertTitle sx={{ fontWeight: 700 }}>{t('legislation.pendingTitle', { count: pending.length })}</AlertTitle>
          <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
            {pending.map((p) => <Chip key={p.id} size="small" label={`${p.refNo} — ${p.title}`} onClick={() => open(p)} sx={{ maxWidth: 420 }} />)}
          </Stack>
        </Alert>
      )}
      <CrudPage<LegalInstrument>
        key={refresh}
        statsScope="legislation" icon={CampaignRoundedIcon} iconColor="#8A5A2B" title={t('legislation.title')} sub={t('legislation.sub')}
        entityName="instrument" endpoint={ENDPOINT} perms={{ create: 'legislation.manage', edit: 'legislation.manage', del: 'legislation.manage' }}
        defaultSort="-issuedDate" searchPlaceholder={t('legislation.searchPlaceholder')} drawerWidth="75vw" exportName="notices-and-circulars"
        onRowClick={(r) => open(r)}
        columns={[
          { key: 'refNo', label: t('legislation.reference'), mono: true, sortable: true, render: (r) => <b>{r.refNo}</b> },
          { key: 'title', label: t('legislation.titleCol'), render: (r) => title(r) },
          { key: 'type', label: t('legislation.type'), exportValue: (r) => types.label(r.type), render: (r) => <Chip size="small" variant="outlined" label={types.label(r.type)} sx={{ height: 20, fontSize: 10.5 }} /> },
          { key: 'category', label: t('legislation.category') },
          { key: 'issuedDate', label: t('legislation.issued'), sortable: true, render: (r) => fmtD(r.issuedDate) },
          { key: 'status', label: t('legislation.status'), render: (r) => <StatusChip value={r.status} map={INSTRUMENT_STATUS_META} /> },
          { key: 'ack', label: t('legislation.acknowledgment'), exportValue: (r) => (r.ackRequired ? (r.acknowledgedBy || []).length : ''), render: (r) => {
            if (!r.ackRequired) return '—';
            return hasAcknowledged(r, uid)
              ? <Chip size="small" icon={<TaskAltRoundedIcon sx={{ fontSize: 14 }} />} label={t('legislation.acknowledged')} color="success" variant="outlined" sx={{ height: 21, fontSize: 10.5 }} />
              : <Chip size="small" label={t('legislation.actionRequired')} color="warning" sx={{ height: 21, fontSize: 10.5 }} />;
          } },
        ]}
        filters={[{ name: 'type', label: t('legislation.type'), lookup: TYPE_LOOKUP }, { name: 'status', label: t('legislation.status'), options: STATUS_OPTIONS }]}
        formFields={[
          { name: 'refNo', label: t('legislation.referenceNumber'), helper: t('legislation.referenceHelper') },
          { name: 'type', label: t('legislation.type'), type: 'select', required: true, lookup: TYPE_LOOKUP },
          { name: 'title', label: t('legislation.titleCol'), required: true, cols: 12 },
          { name: 'titleAr', label: t('legislation.titleArabic'), cols: 12 },
          { name: 'category', label: t('legislation.category') }, { name: 'issuedBy', label: t('legislation.issuedBy') },
          { name: 'issuedDate', label: t('legislation.issuedDate'), type: 'date' }, { name: 'effectiveDate', label: t('legislation.effectiveDate'), type: 'date' },
          { name: 'expiryDate', label: t('legislation.expiryDate'), type: 'date' },
          { name: 'status', label: t('legislation.status'), type: 'select', options: STATUS_OPTIONS },
          { name: 'ackRequired', label: t('legislation.ackRequired'), type: 'switch' },
          { name: 'public', label: t('legislation.public'), type: 'switch', helper: t('legislation.publicHelper') },
          { name: 'summary', label: t('legislation.summary'), type: 'multiline', cols: 12 },
          { name: 'body', label: t('legislation.fullText'), type: 'multiline', rows: 8, cols: 12 },
          { name: 'supersedes', label: t('legislation.supersedes') },
        ]}
        defaults={{ status: 'IN_FORCE', issuedBy: 'Harbour Master', ackRequired: false, public: true }}
        toForm={(row) => ({ ...row, issuedDate: toInputD(row.issuedDate), effectiveDate: toInputD(row.effectiveDate), expiryDate: toInputD(row.expiryDate) })}
        deleteMessage={(r) => t('legislation.deleteMessage', { ref: r?.refNo })}
      />
      <FormDrawer open={!!reading} title={reading?.refNo || ''} subtitle={reading?.title} onClose={() => setReading(null)} width="75vw">
        {reading && (
          <Box>
            {reading.titleAr && <Typography dir="rtl" lang="ar" sx={{ fontWeight: 600, mb: 1.5, textAlign: 'right' }}>{reading.titleAr}</Typography>}
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
              <StatusChip value={reading.status} map={INSTRUMENT_STATUS_META} />
              <Chip size="small" label={types.label(reading.type)} variant="outlined" />
              <Chip size="small" label={reading.category} variant="outlined" />
              <Chip size="small" label={t('legislation.issuedByOn', { date: fmtD(reading.issuedDate), by: reading.issuedBy })} variant="outlined" />
              {reading.effectiveDate && <Chip size="small" label={t('legislation.effectiveFrom', { date: fmtD(reading.effectiveDate) })} variant="outlined" />}
              {reading.expiryDate && <Chip size="small" color={reading.expired ? 'warning' : 'default'} label={t('legislation.expiresOn', { date: fmtD(reading.expiryDate) })} variant="outlined" />}
              {reading.supersedes && <Chip size="small" color="warning" variant="outlined" label={t('legislation.supersedesRef', { ref: reading.supersedes })} />}
              {reading.supersededBy && <Chip size="small" color="warning" label={t('legislation.supersededByRef', { ref: reading.supersededBy })} />}
            </Stack>
            <Typography sx={{ fontWeight: 600, mb: 1.5 }}>{reading.summary}</Typography>
            <Divider sx={{ mb: 2 }} />
            <Typography sx={{ whiteSpace: 'pre-wrap', lineHeight: 1.7, fontSize: 14.5 }}>{reading.body || t('legislation.fullTextRepository')}</Typography>
            {!!(reading.tags || []).length && (
              <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ mt: 2 }}>
                {reading.tags!.map((tag) => <Chip key={tag} size="small" label={tag} sx={{ height: 20, fontSize: 10.5, fontFamily: MONO }} />)}
              </Stack>
            )}
            {!!(reading.links || []).length && (
              <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ mt: 1.5 }} aria-label={t('legislation.links')}>
                {reading.links!.map((l, i) => <Chip key={`${l.kind}-${l.refNo}-${i}`} size="small" variant="outlined" label={`${l.kind.replace(/_/g, ' ').toLowerCase()} · ${l.refNo}`} sx={{ height: 21, fontSize: 10.5 }} />)}
              </Stack>
            )}
            {reading.sourceNote && <Typography variant="caption" color="warning.main" sx={{ display: 'block', mt: 1.5 }}>{reading.sourceNote}</Typography>}
            <Box sx={{ mt: 3, p: 2, borderRadius: 2, bgcolor: 'action.hover' }} data-testid="portal-box">
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
                <PublicRoundedIcon fontSize="small" color={absence ? 'disabled' : 'success'} />
                <Typography variant="subtitle2">{t('legislation.portal.title')}</Typography>
              </Stack>
              {absence === 'DRAFT' && <Typography variant="body2" color="text.secondary">{t('legislation.portal.absentDraft')}</Typography>}
              {absence === 'TYPE' && <Typography variant="body2" color="text.secondary">{t('legislation.portal.absentType', { type: types.label(reading.type) })}</Typography>}
              {absence === 'SWITCH' && <Typography variant="body2" color="warning.main">{t('legislation.portal.absentSwitch')}</Typography>}
              {!absence && reading.portal && (
                <Stack spacing={1}>
                  <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
                    <Link href={reading.portal.url!} target="_blank" rel="noopener" sx={{ fontFamily: MONO, fontSize: 12.5, wordBreak: 'break-all' }}>{reading.portal.url}</Link>
                    <Tooltip title={t('legislation.portal.copyAddress')}><IconButton size="small" aria-label={t('legislation.portal.copyAddress')} onClick={() => copy(reading.portal!.url!)}><ContentCopyRoundedIcon sx={{ fontSize: 16 }} /></IconButton></Tooltip>
                    <Button size="small" variant="outlined" startIcon={<OpenInNewRoundedIcon />} onClick={() => navigate(lawPath(reading.slug || reading.refNo))}>{t('legislation.portal.openPage')}</Button>
                  </Stack>
                  <Box>
                    <Typography variant="caption" color="text.secondary">{t('legislation.portal.citation')}</Typography>
                    <Stack direction="row" spacing={0.5} alignItems="flex-start">
                      <Typography variant="body2" sx={{ flex: 1 }}>{reading.portal.citation}</Typography>
                      <Tooltip title={t('legislation.portal.copyCitation')}><IconButton size="small" aria-label={t('legislation.portal.copyCitation')} onClick={() => copy(reading.portal!.citation || '')}><ContentCopyRoundedIcon sx={{ fontSize: 16 }} /></IconButton></Tooltip>
                    </Stack>
                  </Box>
                  {reading.portal.citationAr && (
                    <Box>
                      <Typography variant="caption" color="text.secondary">{t('legislation.portal.citationAr')}</Typography>
                      <Stack direction="row" spacing={0.5} alignItems="flex-start">
                        <Typography variant="body2" dir="rtl" lang="ar" sx={{ flex: 1, textAlign: 'right' }}>{reading.portal.citationAr}</Typography>
                        <Tooltip title={t('legislation.portal.copyCitation')}><IconButton size="small" aria-label={t('legislation.portal.copyCitationAr')} onClick={() => copy(reading.portal!.citationAr || '')}><ContentCopyRoundedIcon sx={{ fontSize: 16 }} /></IconButton></Tooltip>
                      </Stack>
                    </Box>
                  )}
                  {reading.contentHash && <Typography variant="caption" color="text.secondary" sx={{ fontFamily: MONO }}>{t('legislation.portal.version', { hash: reading.contentHash })}</Typography>}
                </Stack>
              )}
            </Box>
            <Box sx={{ mt: 2, p: 2, borderRadius: 2, bgcolor: 'action.hover' }}>
              <Typography variant="subtitle2" gutterBottom>{t('legislation.governance')}</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: reading.status === 'DRAFT' ? 1.5 : 0 }}>
                {reading.draftedBy ? <>{t('legislation.draftedBy')} <b>{reading.draftedBy}</b>.</> : t('legislation.noDrafter')}
                {reading.approvedBy
                  ? <> {t('legislation.putInForceBy')} <b>{reading.approvedBy}</b> {t('legislation.on')} {fmtD(reading.approvedAt)}.</>
                  : reading.status === 'DRAFT' ? ` ${t('legislation.awaitingApproval')}` : ''}
              </Typography>
              {verdict && verdict.ok && <Button variant="contained" disabled={busy} onClick={() => publish(reading)}>{t('legislation.putInForce')}</Button>}
              {verdict && !verdict.ok && verdict.reason === 'SELF' && <Typography variant="body2" color="error.main">{t('legislation.selfApproval')}</Typography>}
              {verdict && !verdict.ok && verdict.reason === 'NO_DRAFTER' && <Typography variant="body2" color="error.main">{t('legislation.noDrafterRecorded')}</Typography>}
            </Box>
            {reading.ackRequired && (
              <Box sx={{ mt: 2, p: 2, borderRadius: 2, bgcolor: 'action.hover' }}>
                <Typography variant="subtitle2" gutterBottom>{t('legislation.acknowledgment')}</Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>{t('legislation.ackCount', { count: (reading.acknowledgedBy || []).length })}</Typography>
                {hasAcknowledged(reading, uid)
                  ? <Chip icon={<TaskAltRoundedIcon />} label={t('legislation.youAcknowledged')} color="success" />
                  : canAcknowledge(reading, uid)
                    ? <Button variant="contained" disabled={busy} onClick={() => acknowledge(reading)}>{t('legislation.acknowledgeReceipt')}</Button>
                    : <Typography variant="body2" color="text.secondary">{t('legislation.ackOnlyInForce')}</Typography>}
              </Box>
            )}
          </Box>
        )}
      </FormDrawer>
    </>
  );
}
