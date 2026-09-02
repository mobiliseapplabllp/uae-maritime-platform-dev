import { describe, expect, it } from 'vitest';
import { fmtMoney, fmtMoneyShort, fmtMT, fmtNum, initials, titleCase } from '../src/utils/format';
import { setProfile } from '../src/config/runtime';

describe('formatting follows the jurisdiction profile', () => {
  it('formats AED with standard grouping', () => {
    setProfile({ code: 'AE' });
    expect(fmtMoneyShort(1_250_000)).toBe('AED 1.25M');
    expect(fmtMoneyShort(3_500)).toBe('AED 3.5K');
    expect(fmtMoney(1234.5)).toContain('1,234.50');
    expect(fmtNum(1234567)).toBe('1,234,567');
  });
  it('formats INR in lakh-crore when the profile groups that way', () => {
    setProfile({ code: 'IN' });
    expect(fmtMoneyShort(12_500_000)).toBe('₹1.25 Cr');
    expect(fmtMoneyShort(250_000)).toBe('₹2.5 L');
    expect(fmtNum(1234567)).toBe('12,34,567');
    setProfile({ code: 'AE' });
  });
  it('formats tonnage and helpers', () => {
    expect(fmtMT(2_400_000)).toBe('2.40 M MT');
    expect(fmtMT(15_200)).toBe('15.2k MT');
    expect(fmtMT(null)).toBe('—');
    expect(initials('Capt. Omar Al Suwaidi')).toBe('OA');
    expect(titleCase('AT_ANCHORAGE')).toBe('At Anchorage');
  });
});
