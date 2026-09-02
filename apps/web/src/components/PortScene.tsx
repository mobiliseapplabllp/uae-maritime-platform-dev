/* Vector port panorama — dusk over a container terminal, in the platform gradient. Hand-drawn SVG. */
export default function PortScene({ style }: { style?: React.CSSProperties }) {
  return (
    <svg viewBox="0 0 900 1240" preserveAspectRatio="xMidYMid slice" style={style} aria-hidden="true">
      <defs>
        <linearGradient id="ps-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#061530" /><stop offset="0.34" stopColor="#0B3D6E" /><stop offset="0.55" stopColor="#0B74B0" /><stop offset="0.74" stopColor="#75479C" /><stop offset="0.9" stopColor="#BD3861" /><stop offset="1" stopColor="#E2707F" /></linearGradient>
        <linearGradient id="ps-sea" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#7E3A62" /><stop offset="0.18" stopColor="#3C2C5E" /><stop offset="0.6" stopColor="#101E3C" /><stop offset="1" stopColor="#050D1F" /></linearGradient>
        <linearGradient id="ps-glow" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#FFD9A0" stopOpacity="0.9" /><stop offset="1" stopColor="#E2707F" stopOpacity="0" /></linearGradient>
        <radialGradient id="ps-sun" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stopColor="#FFE9C4" /><stop offset="0.55" stopColor="#F7B27A" stopOpacity="0.85" /><stop offset="1" stopColor="#E2707F" stopOpacity="0" /></radialGradient>
      </defs>
      <rect x="0" y="0" width="900" height="820" fill="url(#ps-sky)" />
      <circle cx="618" cy="742" r="150" fill="url(#ps-sun)" />
      <circle cx="618" cy="748" r="52" fill="#FFE2B8" opacity="0.95" />
      <g fill="#EAF2FF"><circle cx="96" cy="98" r="1.7" opacity="0.8" /><circle cx="212" cy="60" r="1.3" opacity="0.6" /><circle cx="318" cy="132" r="1.5" opacity="0.7" /><circle cx="452" cy="76" r="1.2" opacity="0.5" /><circle cx="560" cy="150" r="1.4" opacity="0.55" /><circle cx="700" cy="90" r="1.6" opacity="0.7" /><circle cx="806" cy="180" r="1.3" opacity="0.55" /><circle cx="160" cy="210" r="1.2" opacity="0.5" /></g>
      <g stroke="#0A1830" strokeWidth="3" fill="none" strokeLinecap="round" opacity="0.75"><path d="M300 250 q10 -9 20 0 q10 -9 20 0" /><path d="M352 282 q8 -7 16 0 q8 -7 16 0" /><path d="M258 300 q7 -6 14 0 q7 -6 14 0" /></g>
      <rect x="0" y="820" width="900" height="420" fill="url(#ps-sea)" />
      <rect x="540" y="822" width="160" height="180" fill="url(#ps-glow)" opacity="0.55" />
      <g fill="#F3B27C" opacity="0.5"><rect x="560" y="836" width="118" height="4" rx="2" /><rect x="586" y="852" width="70" height="3.4" rx="2" /><rect x="556" y="872" width="120" height="3.6" rx="2" /><rect x="596" y="896" width="66" height="3" rx="2" /><rect x="566" y="926" width="96" height="3.2" rx="2" /></g>
      <g fill="#7FB4E8" opacity="0.22"><rect x="80" y="860" width="150" height="3" rx="2" /><rect x="150" y="905" width="110" height="3" rx="2" /><rect x="60" y="960" width="180" height="3.4" rx="2" /><rect x="330" y="882" width="130" height="3" rx="2" /><rect x="710" y="900" width="140" height="3" rx="2" /><rect x="300" y="1000" width="180" height="3.6" rx="2" /></g>
      <g fill="#0A1B36">
        <rect x="0" y="796" width="900" height="26" />
        {[30, 120, 210, 640, 730, 820].map((x, i) => (<g key={i}><rect x={x} y={i < 3 ? 742 : 750} width="7" height="60" /><rect x={x - 26} y={i < 3 ? 742 : 750} width="70" height="7" /><rect x={x + 30} y={i < 3 ? 756 : 762} width="5" height="46" /></g>))}
        <rect x="330" y="778" width="240" height="20" rx="3" />
      </g>
      <g fill="#F7C98B">{[60, 150, 250, 660, 760, 845].map((x, i) => <circle key={i} cx={x} cy={788} r="2.4" opacity="0.9" />)}</g>
      <g>
        <path d="M120 966 L806 966 L768 1042 L166 1042 Z" fill="#081226" /><path d="M120 966 L150 940 L806 940 L806 966 Z" fill="#0B1B38" />
        <rect x="708" y="856" width="64" height="86" fill="#0D1E3E" /><rect x="716" y="866" width="48" height="8" fill="#8FB4D8" opacity="0.9" /><rect x="716" y="882" width="48" height="6" fill="#5E82A8" opacity="0.7" />
        <rect x="722" y="838" width="6" height="20" fill="#0D1E3E" /><circle cx="725" cy="834" r="3.4" fill="#F0605B" />
        {([['#1B6FA3', 902], ['#6C4A93', 878], ['#A84D6C', 854]] as [string, number][]).map(([c, y], r) => (
          <g key={r} fill={c}>{Array.from({ length: 13 }).map((_, i) => <rect key={i} x={168 + i * 41} y={y} width="37" height="22" rx="1.5" opacity={0.55 + ((i * 7 + r * 3) % 10) * 0.045} />)}</g>
        ))}
        <g fill="#F7C98B"><circle cx="146" cy="952" r="2.6" /><circle cx="788" cy="950" r="2.6" /></g>
        <path d="M96 1006 q28 -14 56 0 q-30 8 -56 0 Z" fill="#9FC4E8" opacity="0.5" />
      </g>
      {([[40, 1], [330, 0.92]] as [number, number][]).map(([ox, sc], k) => (
        <g key={k} transform={`translate(${ox} 0) scale(${sc})`} fill="#04101F">
          <rect x="60" y="620" width="18" height="560" /><rect x="188" y="620" width="18" height="560" /><rect x="46" y="1160" width="46" height="30" rx="5" /><rect x="174" y="1160" width="46" height="30" rx="5" />
          <rect x="20" y="596" width="420" height="22" /><rect x="52" y="560" width="162" height="40" rx="4" /><path d="M64 560 L150 448 L162 448 L118 560 Z" /><path d="M150 448 L438 596 L438 610 L146 462 Z" /><rect x="146" y="436" width="18" height="18" />
          <g stroke="#04101F" strokeWidth="5"><line x1="300" y1="608" x2="300" y2="700" /><line x1="332" y1="608" x2="332" y2="700" /></g>
          <rect x="286" y="700" width="62" height="18" rx="2" /><rect x="286" y="722" width="62" height="26" rx="2" fill="#155B8C" opacity="0.9" /><circle cx="442" cy="600" r="5" fill="#F0605B" />
          <g fill="#F7C98B"><circle cx="69" cy="640" r="3" /><circle cx="197" cy="640" r="3" /></g>
        </g>
      ))}
      <rect x="0" y="1180" width="900" height="60" fill="#030B18" />
      <g>{([['#155B8C', 0], ['#5A3B7E', 1], ['#8C3A57', 2]] as [string, number][]).map(([c, r]) => (<g key={r} fill={c}>{Array.from({ length: 6 }).map((_, i) => <rect key={i} x={560 + i * 56} y={1128 - r * 30} width="52" height="28" rx="2" opacity={0.8 - r * 0.14} />)}</g>))}</g>
      <g><rect x="80" y="1064" width="8" height="116" fill="#04101F" /><circle cx="84" cy="1058" r="7" fill="#FFDFA6" /><circle cx="84" cy="1058" r="16" fill="#FFDFA6" opacity="0.22" /><rect x="480" y="1084" width="8" height="96" fill="#04101F" /><circle cx="484" cy="1078" r="7" fill="#FFDFA6" /><circle cx="484" cy="1078" r="16" fill="#FFDFA6" opacity="0.22" /></g>
    </svg>
  );
}
