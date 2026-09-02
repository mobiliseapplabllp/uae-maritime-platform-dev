import { Grid, TextField, MenuItem, FormControlLabel, Switch, Autocomplete } from '@mui/material';
import type { FieldSpec } from '../../types';

interface Props { fields: FieldSpec[]; values: Record<string, any>; onChange: (v: Record<string, any>) => void; errors?: Record<string, string> }
/** Config-driven form renderer. */
export default function FormFields({ fields, values, onChange, errors = {} }: Props) {
  const set = (name: string, v: unknown) => onChange({ ...values, [name]: v });
  return (
    <Grid container spacing={2}>
      {fields.map((f) => {
        const v = values[f.name] ?? '';
        const common = { fullWidth: true, size: 'small' as const, label: f.label, required: f.required, disabled: f.disabled, error: !!errors[f.name], helperText: errors[f.name] || f.helper };
        let el: React.ReactNode;
        if (f.type === 'select') {
          el = (
            <TextField {...common} select value={v} onChange={(e) => set(f.name, e.target.value)}>
              {!f.required && <MenuItem value=""><em>—</em></MenuItem>}
              {(f.options || []).map((o) => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}
            </TextField>
          );
        } else if (f.type === 'autocomplete') {
          const opts = f.options || [];
          el = <Autocomplete options={opts} size="small" value={opts.find((o) => o.value === v) || null} onChange={(_, o) => set(f.name, o ? o.value : '')} renderInput={(params) => <TextField {...params} {...common} />} />;
        } else if (f.type === 'switch') {
          el = <FormControlLabel control={<Switch checked={!!values[f.name]} onChange={(e) => set(f.name, e.target.checked)} />} label={f.label} />;
        } else if (f.type === 'multiline') {
          el = <TextField {...common} multiline minRows={f.rows || 2} value={v} onChange={(e) => set(f.name, e.target.value)} placeholder={f.placeholder} />;
        } else {
          el = (
            <TextField {...common} type={f.type === 'datetime' ? 'datetime-local' : f.type || 'text'} value={v}
              onChange={(e) => set(f.name, f.type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value)}
              InputLabelProps={['date', 'datetime'].includes(f.type || '') ? { shrink: true } : undefined} placeholder={f.placeholder} />
          );
        }
        return <Grid item xs={12} sm={f.cols || 6} key={f.name}>{el}</Grid>;
      })}
    </Grid>
  );
}
