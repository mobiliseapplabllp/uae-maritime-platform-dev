import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../../api/client';
import { useAppDispatch, useAppSelector } from '../../store';
import { clearSession } from '../../store/authSlice';
import { notify } from '../../store/uiSlice';

/**
 * The client half of the idle window. The server ends a session whose refresh comes too late; this signs the person
 * out on the screen at the same moment, so a workstation left unattended does not sit open until the next request.
 */
export default function IdleWatch() {
  const { t } = useTranslation();
  const dispatch = useAppDispatch();
  const minutes = useAppSelector((s) => s.auth.policy?.idleTimeoutMinutes ?? 30);
  const refreshToken = useAppSelector((s) => s.auth.refreshToken);
  useEffect(() => {
    let last = Date.now();
    const bump = () => { last = Date.now(); };
    const events: (keyof WindowEventMap)[] = ['mousemove', 'keydown', 'click', 'touchstart', 'scroll', 'focus'];
    for (const e of events) window.addEventListener(e, bump, { passive: true });
    const timer = window.setInterval(() => {
      if (Date.now() - last < minutes * 60_000) return;
      window.clearInterval(timer);
      api.post('/auth/logout', { refreshToken }, { headers: { 'X-Quiet': '1' } }).catch(() => undefined);
      dispatch(clearSession());
      dispatch(notify({ message: t('security.signedOutIdle', { minutes }), severity: 'warning' }));
    }, 15_000);
    return () => { window.clearInterval(timer); for (const e of events) window.removeEventListener(e, bump); };
  }, [minutes, refreshToken, dispatch, t]);
  return null;
}
