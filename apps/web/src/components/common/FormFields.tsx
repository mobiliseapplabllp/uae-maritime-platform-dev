import { Grid, TextField, MenuItem, FormControlLabel, Switch, Autocomplete } from '@mui/material';
import type { FieldSpec, Option } from '../../types';
import { useLookupOptions } from '../../hooks/useLookups';

interface Props { fields: FieldSpec[]; values: Record<string, any>; onChange: (v: Record<string, any>) => void; errors?: Record<string, string> }
type Common = { fullWidth: true; size: 'small'; label: string; required?: boolean; disabled?: boolean; error: boolean; helperText?: string };

/** A select or autocomplete whose options are a Data Studio master: resolved once per master, labelled in the interface language. */
function ChoiceField({ f, value, options, common, onChange }: { f: FieldSpec; value: unknown; options: Option[]; common: Common; onChange: (v: unknown) => void }) {
  if (f.type === 'autocomplete') {
    return <Autocomplete options={options} size="small" value={options.find((o) => o.value === value) || null} onChange={(_, o) => onChange(o ? o.value : '')} renderInput={(params) => <TextField {...params} {...common} />} />;
  }
  return (
    <TextField {...common} select value={value ?? ''} onChange={(e) => onChange(e.target.value)}>
      {!f.required && <MenuItem value=""><em>—</em></MenuItem>}
      {options.map((o) => <MenuItem key={o.value} value={o.value}>{o.label}</MenuItem>)}
    </TextField>
  );
}
function LookupField(props: { f: FieldSpec; value: unknown; common: Common; onChange: (v: unknown) => void }) {
  const options = useLookupOptions(props.f.lookup);
  return <ChoiceField {...props} options={options} />;
}

/** Config-driven form renderer. */
export default function FormFields({ fields, values, onChange, errors = {} }: Props) {
  const set = (name: string, v: unknown) => onChange({ ...values, [name]: v });
  return (
    <Grid container spacing={2}>
      {fields.map((f) => {
        const v = values[f.name] ?? '';
        const common: Common = { fullWidth: true, size: 'small', label: f.label, required: f.required, disabled: f.disabled, error: !!errors[f.name], helperText: errors[f.name] || f.helper };
        let el: React.ReactNode;
        if ((f.type === 'select' || f.type === 'autocomplete') && f.lookup && !f.options) {
          el = <LookupField f={f} value={v} common={common} onChange={(x) => set(f.name, x)} />;
        } else if (f.type === 'select' || f.type === 'autocomplete') {
          el = <ChoiceField f={f} value={v} options={f.options || []} common={common} onChange={(x) => set(f.name, x)} />;
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
