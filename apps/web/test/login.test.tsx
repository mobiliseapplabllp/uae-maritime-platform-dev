import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '@mui/material';
import '../src/i18n';
import { store } from '../src/store';
import { buildTheme } from '../src/theme';
import Login from '../src/pages/Login';
import api from '../src/api/client';

describe('Login page', () => {
  it('renders the role shortcuts and signs in through the API', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({ success: true, data: { user: { id: '1', name: 'Admin', email: 'admin@maritime.example', active: true, kind: 'user', scope: { level: 'NATIONAL' }, role: { id: 'r', name: 'Super Admin', permissions: ['*'] }, perms: ['*'] }, token: 't', refreshToken: 'r' } } as never);
    render(<Provider store={store}><MemoryRouter><ThemeProvider theme={buildTheme('light')}><Login /></ThemeProvider></MemoryRouter></Provider>);
    expect(screen.getByText('Welcome aboard')).toBeInTheDocument();
    expect(screen.getAllByText(/Harbour Master|Super Admin|Marine Surveyor|Finance Officer|Shipping Agent/).length).toBeGreaterThanOrEqual(5);
    fireEvent.click(screen.getByTestId('login-super-admin'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/auth/login', { email: 'admin@maritime.example', password: 'Demo@2026' }));
    await waitFor(() => expect(store.getState().auth.user?.role.name).toBe('Super Admin'));
    post.mockRestore();
  });
});
