import type { Row } from './tools';

/* Explaining one figure on a dashboard.
 *
 * A chart, a panel, a yardstick or a stat card sends the figures it is drawn from, and the explanation is composed
 * from those figures alone: what the card shows, what the numbers say (their range, their direction, the largest
 * and smallest), whether a yardstick is on its target, and what the measure means in the trade. Every sentence is
 * deterministic and traceable to a number on the screen. When Settings → AI name a hosted provider, these same facts
 * go to it as the grounding and it writes the prose; the facts still stand as the record of what was true. */

export type ExplainKind = 'chart' | 'stat' | 'yardstick' | 'panel' | 'list';
export interface ExplainInput {
  kind: ExplainKind; title: string; sub?: string; module?: string; data?: unknown;
  value?: string | number | null; target?: string | number | null; unit?: string; period?: string; language?: 'en' | 'ar';
}
export interface Explanation { text: string; facts: string[]; meaning: string | null; grounding: { label: string; kind: string; text: string }[] }

type Lang = 'en' | 'ar';
const pick = (lang: Lang, en: string, ar: string) => (lang === 'ar' ? ar : en);
const fmt = (v: number) => (Number.isInteger(v) ? v.toLocaleString('en-AE') : v.toLocaleString('en-AE', { maximumFractionDigits: 1, minimumFractionDigits: 1 }));
const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 10 : 0);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const firstNumber = (v: unknown): number | null => { if (isNum(v)) return v; const m = String(v ?? '').replace(/,/g, '').match(/-?\d+(?:\.\d+)?/); return m ? Number(m[0]) : null; };

/** What each measure means in the trade, keyed by the words a card's title carries. */
const GLOSSARY: [RegExp, string, string][] = [
  [/days sales outstanding|\bdso\b/i, 'Days sales outstanding is how many days, on average, an invoice stays unpaid after it is issued; lower is better, and the trade watches for it creeping past the credit terms.', 'أيام المبيعات المستحقة هي متوسط عدد الأيام التي تبقى فيها الفاتورة غير مسددة بعد إصدارها؛ الأقل أفضل، ويُراقب تجاوزها لشروط الائتمان.'],
  [/collection effectiveness|\bcei\b/i, 'The collection effectiveness index compares what was collected in the period with what could have been collected; 100% means every due amount came in.', 'مؤشر فعالية التحصيل يقارن ما حُصِّل خلال الفترة بما كان يمكن تحصيله؛ 100% تعني أن كل المبالغ المستحقة وصلت.'],
  [/paid on time/i, 'Paid on time is the share of invoices settled by their due date; the rest become receivables to chase.', 'المسدَّد في موعده هو نسبة الفواتير المسدَّدة قبل تاريخ استحقاقها؛ وما تبقى يصبح ذمماً تُتابع.'],
  [/ageing|aging/i, 'Ageing sorts what is owed by how long it has been outstanding; the older the bucket, the harder the money is to collect.', 'التقادم يصنّف المستحقات بحسب مدة تأخرها؛ كلما تقدّمت الشريحة صعب تحصيل المبلغ.'],
  [/outstanding|receivable/i, 'Outstanding is the money invoiced and not yet received, whether or not it is overdue.', 'المستحق هو المبلغ المفوتر الذي لم يُستلم بعد، سواء تأخر أم لا.'],
  [/overdue/i, 'Overdue is the part of the outstanding balance past its due date; it is the first thing a reminder goes after.', 'المتأخر هو الجزء من الرصيد المستحق الذي تجاوز موعده؛ وهو أول ما يُطالَب به.'],
  [/billed|revenue/i, 'Billed is what was invoiced in the period, before any of it is collected.', 'المفوتر هو ما صدرت به فواتير خلال الفترة قبل تحصيل أي منه.'],
  [/collected/i, 'Collected is the cash that actually arrived in the period, whatever period it was billed in.', 'المحصَّل هو النقد الذي وصل فعلاً خلال الفترة أياً كانت فترة فوترته.'],
  [/turnaround/i, 'Turnaround is the time from a ship\'s arrival to her departure; shorter turnaround means the berth is free for the next call sooner.', 'زمن الدوران هو الوقت من وصول السفينة إلى مغادرتها؛ وكلما قصر تحرر الرصيف للنداء التالي أسرع.'],
  [/occupancy/i, 'Berth occupancy is the share of berth-hours in use; the trade aims between sixty and eighty-five percent — lower is idle quay, higher means ships wait.', 'إشغال الأرصفة هو نسبة ساعات الأرصفة المستخدمة؛ ويستهدف القطاع ما بين 60 و85 بالمئة، فالأقل رصيف عاطل والأعلى سفن تنتظر.'],
  [/anchorage|waiting/i, 'Anchorage waiting is the time a ship spends at anchor before a berth is available; the harbour watches the average and the share past the alert line.', 'الانتظار في المرسى هو الوقت الذي تقضيه السفينة راسية قبل توفر رصيف؛ ويُراقَب المتوسط ونسبة ما تجاوز خط الإنذار.'],
  [/eta reliability/i, 'ETA reliability is the share of arrivals within the agreed window of the time the agent declared; it drives how well the berth plan holds.', 'موثوقية وقت الوصول المتوقع هي نسبة الوصول ضمن النافذة المتفق عليها من الوقت الذي أعلنه الوكيل؛ وهي ما يحدد صمود خطة الأرصفة.'],
  [/tug utili[sz]ation|pilots?\b/i, 'Tug utilisation is the share of the marine craft\'s available hours spent on jobs; too high and calls queue, too low and the fleet is oversized.', 'استخدام القاطرات هو نسبة ساعات المركبات البحرية المتاحة المستغلة في المهام؛ الأعلى كثيراً يعني طوابير والأقل كثيراً أسطولاً أكبر من الحاجة.'],
  [/downtime|out of service|outage|availability/i, 'Berth downtime is the time a berth could not take a ship, planned or not; availability is the mirror figure.', 'توقف الرصيف هو الوقت الذي تعذّر فيه على الرصيف استقبال سفينة، مخططاً كان أو غير مخطط؛ والتوافر هو الصورة المقابلة.'],
  [/throughput|cargo|tonnes|\bteu\b/i, 'Throughput is the cargo handled across the quays in the period, in tonnes with containers converted at a standard weight.', 'المناولة هي البضائع المتداولة على الأرصفة خلال الفترة بالأطنان، مع تحويل الحاويات بوزن قياسي.'],
  [/arrivals|expected/i, 'Expected arrivals are the calls the agents have declared for the window ahead, confirmed or announced.', 'الوصول المتوقع هو النداءات التي أعلنها الوكلاء للنافذة القادمة، مؤكدة أو معلنة.'],
  [/detention/i, 'A detention holds a ship in port until deficiencies that make her unsafe are put right; the detention rate is the share of inspections that end in one.', 'الاحتجاز يبقي السفينة في الميناء حتى تصحيح أوجه القصور التي تجعلها غير آمنة؛ ومعدل الاحتجاز هو نسبة التفتيشات التي تنتهي به.'],
  [/deficienc/i, 'A deficiency is a finding on an inspection that has to be rectified; open ones are the surveyor\'s follow-up list.', 'وجه القصور هو ملاحظة في التفتيش يجب تصحيحها؛ والمفتوحة منها هي قائمة متابعة المساح.'],
  [/satisf|results?\b/i, 'The result of an inspection is satisfactory when nothing needs rectifying; the share of satisfactory results is the register\'s health.', 'نتيجة التفتيش مرضية عندما لا يلزم تصحيح شيء؛ ونسبة النتائج المرضية هي صحة السجل.'],
  [/checklist compliance/i, 'Checklist compliance is the share of checklist items answered on the inspections completed; it says how completely the surveys were recorded.', 'الالتزام بقائمة التحقق هو نسبة بنود القائمة المجاب عنها في التفتيشات المنجزة؛ ويبيّن اكتمال تسجيل المعاينات.'],
  [/first.time.right/i, 'First time right is the share of applications decided without a request for more information; it measures how well the form asked for what the assessor needs.', 'الصحيح من أول مرة هو نسبة الطلبات التي بُتّ فيها دون طلب معلومات إضافية؛ ويقيس جودة النموذج في طلب ما يحتاجه المقيّم.'],
  [/straight.through/i, 'Straight-through is the share of applications that passed every stage without a person intervening.', 'المعالجة المباشرة هي نسبة الطلبات التي اجتازت كل المراحل دون تدخل شخص.'],
  [/service level|\bsla\b|past service|breached|within service/i, 'The service level is the promised time to a decision; an application past it is breached and counts against the desk.', 'مستوى الخدمة هو الوقت الموعود للقرار؛ والطلب الذي يتجاوزه مخلٌّ ويُحتسب على المكتب.'],
  [/decision time|decided/i, 'Decision time is the days from submission to a decision; the median is quoted so one slow file does not move the figure.', 'زمن القرار هو الأيام من التقديم إلى القرار؛ ويُذكر الوسيط حتى لا يحرّك ملف بطيء واحد الرقم.'],
  [/fees/i, 'Fees are what the services charged and collected in the period, at the tariff the definitions carry.', 'الرسوم هي ما فرضته الخدمات وحصّلته خلال الفترة وفق التعرفة التي تحملها التعريفات.'],
  [/acknowledg/i, 'An acknowledgement records that a person or company has read a notice they were required to read; compliance is the share received of those owed.', 'الإقرار يسجّل أن شخصاً أو شركة قرأ إشعاراً كان ملزماً بقراءته؛ والالتزام هو نسبة المستلَم مما هو مستحق.'],
  [/review age|past review|older than/i, 'Review age is how long an instrument has stood since it was last reviewed; the library\'s cycle says when one is due again.', 'عمر المراجعة هو المدة منذ آخر مراجعة للوثيقة؛ ودورة المكتبة تحدد موعد مراجعتها التالية.'],
  [/imo watch|seen to|transposed|assessed/i, 'The IMO watch tracks changes from the international bodies from the day they are seen to the day they are assessed and transposed into the library.', 'مرصد المنظمة البحرية الدولية يتابع التغييرات الصادرة عن الهيئات الدولية من يوم رصدها إلى يوم تقييمها ونقلها إلى المكتبة.'],
  [/in force|coming into force|issued/i, 'In force counts the instruments that apply today; issued counts those published in the period, whether or not they have taken effect.', 'النافذ يحصي الوثائق السارية اليوم؛ والصادر يحصي ما نُشر خلال الفترة سواء دخل حيز التنفيذ أم لا.'],
  [/second factor|\bmfa\b|authenticator/i, 'Second-factor coverage is the share of accounts that hold an enrolled authenticator among those required to; the gap is the exposure.', 'تغطية العامل الثاني هي نسبة الحسابات التي سجّلت أداة مصادقة من بين الحسابات الملزمة بذلك؛ والفارق هو مساحة الخطر.'],
  [/dormant/i, 'A dormant account has not signed in for the configured period; the sweep deactivates them so unused access does not linger.', 'الحساب الخامل لم يسجّل الدخول خلال المدة المحددة؛ والمسح يعطّله حتى لا يبقى وصول غير مستخدم.'],
  [/privileged/i, 'Privileged accounts hold the wildcard or the administration of accounts and roles; every grant to one waits for a second administrator.', 'الحسابات المميزة تحمل صلاحية شاملة أو إدارة الحسابات والأدوار؛ وكل منح لأحدها ينتظر مسؤولاً ثانياً.'],
  [/access review/i, 'An access review has every account attested or revoked by its owner within a window; progress is the share already decided.', 'مراجعة الوصول تُثبت كل حساب أو تلغيه من قِبل مالكه ضمن نافذة زمنية؛ والتقدم هو نسبة ما بُتّ فيه.'],
  [/locked|failed login/i, 'Locked out counts accounts frozen after repeated failed sign-ins; the failed attempts behind them are the signal to read.', 'المقفل يحصي الحسابات المجمَّدة بعد محاولات دخول فاشلة متكررة؛ والمحاولات الفاشلة وراءها هي الإشارة الواجب قراءتها.'],
  [/completeness|uniqueness|validity|timeliness|data quality|quality score/i, 'Data quality grades the masters on completeness, uniqueness, validity, timeliness and Arabic coverage; the score is their weighted mean.', 'جودة البيانات تقيّم الجداول المرجعية على الاكتمال والتفرد والصلاحية والحداثة والتغطية العربية؛ والدرجة هي متوسطها الموزون.'],
  [/arabic|bilingual/i, 'Arabic coverage is the share of master entries that carry an Arabic label as well as the English one.', 'التغطية العربية هي نسبة مداخل الجداول المرجعية التي تحمل تسمية عربية إلى جانب الإنجليزية.'],
  [/duplicate/i, 'Duplicates are entries whose labels collide within a master; each is a choice the runtime cannot make for a person.', 'التكرارات هي مداخل تتطابق تسمياتها داخل جدول مرجعي واحد؛ وكل منها خيار لا يمكن للنظام اتخاذه بدل الشخص.'],
  [/stale|untouched/i, 'A stale master has not been touched within the period the studio watches; it may still be right, but nobody has confirmed it.', 'الجدول المرجعي الراكد لم يُمسّ خلال المدة التي يراقبها الاستوديو؛ قد يكون صحيحاً لكن لم يؤكده أحد.'],
  [/mtta|time to acknowledge/i, 'Mean time to acknowledge is how long an incident waits before someone takes it; the desk\'s first promise.', 'متوسط زمن الإقرار هو مدة انتظار الحادث قبل أن يتولاه أحد؛ وهو أول وعود المكتب.'],
  [/mttr|time to resolve/i, 'Mean time to resolve is how long an incident stays open from report to closure.', 'متوسط زمن الحل هو مدة بقاء الحادث مفتوحاً من الإبلاغ إلى الإغلاق.'],
  [/injur/i, 'Injuries are the incidents that hurt a person; each carries a report clock the desk must meet.', 'الإصابات هي الحوادث التي ألحقت أذى بشخص؛ ولكل منها مهلة تقرير يجب أن يلتزم بها المكتب.'],
  [/open cases|open incidents|incidents/i, 'Open incidents are the case files still being worked; high and critical ones page the duty officer.', 'الحوادث المفتوحة هي الملفات التي ما زالت قيد العمل؛ والعالية والحرجة منها تستدعي ضابط المناوبة.'],
  [/risk band|composite risk|targeting/i, 'The composite risk band is scored from a ship\'s certificates, inspections and detentions; it decides who is boarded next.', 'فئة المخاطر المركّبة تُحتسب من شهادات السفينة وتفتيشاتها واحتجازاتها؛ وهي ما يحدد من يُصعد إليه بعد ذلك.'],
  [/certificate/i, 'Certificate health is the share of statutory certificates in good standing across the fleet; expiring and expired ones are the register\'s follow-up list.', 'صحة الشهادات هي نسبة الشهادات القانونية السارية عبر الأسطول؛ والمنتهية أو التي تقارب الانتهاء هي قائمة متابعة السجل.'],
  [/expir|lapsing/i, 'Lapsing counts the instruments that reach their expiry within the window; the register chases renewals before that date.', 'المنتهي قريباً يحصي الوثائق التي تبلغ نهاية صلاحيتها ضمن النافذة؛ ويتابع السجل التجديد قبل ذلك التاريخ.'],
  [/renewal/i, 'Renewals on time is the share of instruments renewed before they lapsed; a late renewal is a gap in cover.', 'التجديد في موعده هو نسبة الوثائق المجدَّدة قبل انقضائها؛ والتجديد المتأخر ثغرة في التغطية.'],
  [/obligation/i, 'Obligations are the conditions an accreditation carries — returns, audits, renewals — each with a due date the register watches.', 'الالتزامات هي الشروط التي يحملها الاعتماد من تقارير وتدقيقات وتجديدات، ولكل منها موعد يراقبه السجل.'],
  [/audit/i, 'Audits are the visits paid to a company or facility against its accreditation; non-conformities are what they found.', 'التدقيقات هي الزيارات لشركة أو منشأة وفق اعتمادها؛ وعدم المطابقة هو ما وجدته.'],
  [/medical/i, 'A medical alert is a seafarer whose fitness certificate has lapsed or is about to; they cannot sign on until it is renewed.', 'التنبيه الطبي يخص بحّاراً انتهت شهادة لياقته أو تقارب الانتهاء؛ ولا يمكنه الالتحاق حتى تجديدها.'],
  [/sea service/i, 'Sea service is the days a seafarer has logged on board; it is what a certificate of competency is earned against.', 'الخدمة البحرية هي الأيام التي سجّلها البحّار على متن السفن؛ وهي ما تُكتسب بموجبه شهادة الكفاءة.'],
  [/crew list/i, 'A crew list is lodged for every call; the count is the manning the harbour knows about.', 'قائمة الطاقم تُودع لكل نداء؛ والعدد هو التطقيم الذي يعرفه الميناء.'],
  [/on board|\broll\b|seafarers/i, 'The roll is every seafarer the register knows; on board and ashore split it by where they are today.', 'السجل هو كل بحّار يعرفه النظام؛ وعلى المتن أو على البر يقسمه بحسب مكانه اليوم.'],
  [/accreditation|licen[cs]e/i, 'Instruments in force are the licences and accreditations that apply today; the register issues, renews and revokes them.', 'الوثائق النافذة هي الرخص والاعتمادات السارية اليوم؛ والسجل يصدرها ويجددها ويلغيها.'],
  [/agents?\b|decisions/i, 'Agent decisions are the conclusions the agents reached; auto-applied ones acted within their latitude, escalated ones waited for a person.', 'قرارات الوكلاء هي الاستنتاجات التي توصلوا إليها؛ المطبَّقة تلقائياً تصرّفت ضمن صلاحيتها، والمصعَّدة انتظرت شخصاً.'],
  [/services up|targets watched|platform/i, 'Services up is how many of the platform\'s services answer their health check now; targets watched are the counterparts the observability service polls.', 'الخدمات العاملة هي عدد خدمات المنصة التي تجيب فحص الصحة الآن؛ والأهداف المراقَبة هي الأطراف التي تستطلعها خدمة الرصد.'],
  [/applications|received|open\b/i, 'Applications open are the service requests still moving through the desk; received and decided count the period\'s inflow and outflow.', 'الطلبات المفتوحة هي طلبات الخدمة التي ما زالت تتحرك في المكتب؛ والمستلَم والمبتوت فيه يحصيان الوارد والصادر في الفترة.'],
  [/vessels|fleet|registered/i, 'The registered fleet is every ship on the register; in port, at anchor and inbound split those the harbour can see today.', 'الأسطول المسجل هو كل سفينة في السجل؛ وفي الميناء أو في المرسى أو القادمة تقسم ما يراه الميناء اليوم.'],
  [/users|accounts|signed in|sessions/i, 'Active accounts are the people who can sign in; signed in and live sessions show who is actually using the platform now.', 'الحسابات النشطة هي من يمكنهم تسجيل الدخول؛ والمسجَّلون والجلسات الحية تبيّن من يستخدم المنصة فعلاً الآن.'],
];

/** The words of the title that name a measure, and what that measure means. */
export function meaningOf(title: string, sub: string | undefined, lang: Lang): string | null {
  const probe = `${title} ${sub ?? ''}`;
  const hit = GLOSSARY.find(([re]) => re.test(title)) ?? GLOSSARY.find(([re]) => re.test(probe));
  return hit ? pick(lang, hit[1], hit[2]) : null;
}

const LABEL_KEYS = ['label', 'month', 'name', 'day', 'bucket', 'kind', 'terminal', 'category', 'role', 'department', 'type', 'stage', 'period', 'week', 'code', 'key'];
const TIME_KEYS = new Set(['month', 'day', 'period', 'week']);
const SKIP = /(^id$|Id$|^key$|^color$|^colour$|^tone$|^href$|^to$)/;

/** What a series of rows says: its direction over time, or its largest and smallest members. */
export function seriesFacts(rows: Row[], lang: Lang): string[] {
  const usable = rows.filter((r) => r && typeof r === 'object' && !Array.isArray(r)).slice(0, 400);
  if (!usable.length) return [];
  const keys = Object.keys(usable[0]);
  const labelKey = LABEL_KEYS.find((k) => keys.includes(k) && usable.some((r) => typeof r[k] === 'string')) ?? keys.find((k) => usable.filter((r) => typeof r[k] === 'string').length >= usable.length / 2) ?? null;
  const numeric = keys.filter((k) => k !== labelKey && !SKIP.test(k) && usable.filter((r) => isNum(r[k])).length >= usable.length / 2).slice(0, 4);
  if (!numeric.length) return [];
  const labelOf = (r: Row, i: number) => (labelKey && r[labelKey] != null ? String(r[labelKey]) : `#${i + 1}`);
  const isTime = !!labelKey && (TIME_KEYS.has(labelKey) || usable.every((r) => /^\d{4}-\d{2}|^[A-Z][a-z]{2} \d{2}$|^\d{1,2}\/\d{1,2}/.test(String(r[labelKey] ?? ''))));
  const facts: string[] = [];
  for (const k of numeric) {
    const pts = usable.map((r, i) => ({ v: r[k], l: labelOf(r, i) })).filter((p): p is { v: number; l: string } => isNum(p.v));
    if (pts.length < 1) continue;
    const values = pts.map((p) => p.v); const total = values.reduce((a, b) => a + b, 0); const mean = total / values.length;
    let max = pts[0]; let min = pts[0]; for (const p of pts) { if (p.v > max.v) max = p; if (p.v < min.v) min = p; }
    const name = k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
    if (isTime && pts.length >= 2) {
      const first = pts[0]; const last = pts[pts.length - 1]; const change = last.v - first.v; const rel = first.v ? Math.round((change / Math.abs(first.v)) * 100) : null;
      const dir = change > 0 ? pick(lang, 'up', 'ارتفع') : change < 0 ? pick(lang, 'down', 'انخفض') : pick(lang, 'unchanged', 'دون تغيير');
      facts.push(pick(lang,
        `${name}: ${fmt(first.v)} in ${first.l} to ${fmt(last.v)} in ${last.l}, ${dir}${rel !== null && change !== 0 ? ` ${Math.abs(rel)}%` : ''}; highest ${fmt(max.v)} in ${max.l}, lowest ${fmt(min.v)} in ${min.l}; average ${fmt(mean)} over ${pts.length} ${pick(lang, 'points', 'نقطة')}.`,
        `${name}: من ${fmt(first.v)} في ${first.l} إلى ${fmt(last.v)} في ${last.l}، ${dir}${rel !== null && change !== 0 ? ` بنسبة ${Math.abs(rel)}%` : ''}؛ الأعلى ${fmt(max.v)} في ${max.l} والأدنى ${fmt(min.v)} في ${min.l}؛ المتوسط ${fmt(mean)} عبر ${pts.length} نقطة.`));
    } else {
      facts.push(pick(lang,
        `${name}: ${fmt(total)} in total across ${pts.length} ${pick(lang, 'entries', 'مدخلاً')}; largest ${max.l} at ${fmt(max.v)} (${pct(max.v, total)}%), smallest ${min.l} at ${fmt(min.v)}.`,
        `${name}: الإجمالي ${fmt(total)} عبر ${pts.length} مدخلاً؛ الأكبر ${max.l} بقيمة ${fmt(max.v)} (${pct(max.v, total)}%) والأصغر ${min.l} بقيمة ${fmt(min.v)}.`));
    }
  }
  return facts;
}

/** The scalar entries of an object, one level down, as short "name: value" facts. */
export function objectFacts(obj: Row, lang: Lang): string[] {
  const pairs: string[] = [];
  const walk = (o: Row, prefix: string) => {
    for (const [k, v] of Object.entries(o)) {
      if (pairs.length >= 10) return;
      if (isNum(v) || typeof v === 'string' || typeof v === 'boolean') pairs.push(`${prefix}${k.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()}: ${isNum(v) ? fmt(v) : String(v)}`);
      else if (v && typeof v === 'object' && !Array.isArray(v) && !prefix) walk(v as Row, `${k} `);
    }
  };
  walk(obj, '');
  return pairs.length ? [pick(lang, `The figures behind the card: ${pairs.join('; ')}.`, `الأرقام وراء البطاقة: ${pairs.join('؛ ')}.`)] : [];
}

/** A yardstick against its target: on it, or off it by how much. */
export function yardstickFacts(value: unknown, target: unknown, lang: Lang): string[] {
  const v = firstNumber(value); const tgt = firstNumber(target);
  if (v === null || tgt === null) return [];
  const t = String(target ?? '');
  const lowerIsBetter = /≤|<|under|within|below|at most|no more/i.test(t) && !/≥|>|at least|above|over/i.test(t);
  const higherIsBetter = /≥|>|at least|above|over|no less/i.test(t);
  const on = lowerIsBetter ? v <= tgt : higherIsBetter ? v >= tgt : Math.abs(v - tgt) <= Math.abs(tgt) * 0.1;
  const gap = Math.abs(v - tgt); const rel = tgt ? Math.round((gap / Math.abs(tgt)) * 100) : null;
  return [on
    ? pick(lang, `The reading of ${String(value)} is on target (${t.trim()}).`, `القراءة ${String(value)} ضمن الهدف (${t.trim()}).`)
    : pick(lang, `The reading of ${String(value)} is off target (${t.trim()}) by ${fmt(gap)}${rel !== null ? `, ${rel}% of the target` : ''}.`, `القراءة ${String(value)} خارج الهدف (${t.trim()}) بفارق ${fmt(gap)}${rel !== null ? `، أي ${rel}% من الهدف` : ''}.`)];
}

const trimRows = (data: unknown): unknown => {
  const cut = (v: unknown): unknown => (typeof v === 'string' ? v.slice(0, 80) : v);
  if (Array.isArray(data)) return data.slice(0, 60).map((r) => (r && typeof r === 'object' ? Object.fromEntries(Object.entries(r as Row).slice(0, 12).map(([k, v]) => [k, cut(v)])) : cut(r)));
  if (data && typeof data === 'object') return Object.fromEntries(Object.entries(data as Row).slice(0, 20).map(([k, v]) => [k, Array.isArray(v) ? trimRows(v) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Row).slice(0, 12)) : cut(v)]));
  return data;
};

/** The explanation composed from the figures alone, in the reader's language, with the facts kept apart from the prose. */
export function explainLocally(input: ExplainInput): Explanation {
  const lang: Lang = input.language === 'ar' ? 'ar' : 'en';
  const facts: string[] = [];
  const data = input.data;
  if (input.kind === 'yardstick') facts.push(...yardstickFacts(input.value, input.target, lang));
  if (input.kind === 'stat' && input.value !== undefined && input.value !== null) facts.push(pick(lang, `The card reads ${String(input.value)}${input.unit ? ` ${input.unit}` : ''}.`, `تقرأ البطاقة ${String(input.value)}${input.unit ? ` ${input.unit}` : ''}.`));
  if (Array.isArray(data)) {
    facts.push(...seriesFacts(data as Row[], lang));
    if (!facts.length && data.length) facts.push(pick(lang, `${data.length} entries are listed.`, `مدرج ${data.length} مدخلاً.`));
  } else if (data && typeof data === 'object') {
    const d = data as Row;
    const arrays = Object.entries(d).filter(([, v]) => Array.isArray(v) && (v as unknown[]).length && typeof (v as unknown[])[0] === 'object').sort((a, b) => (b[1] as unknown[]).length - (a[1] as unknown[]).length);
    for (const [k, v] of arrays.slice(0, 2)) { const f = seriesFacts(v as Row[], lang); if (f.length) facts.push(pick(lang, `${k}: `, `${k}: `) + f.join(' ')); }
    facts.push(...objectFacts(Object.fromEntries(Object.entries(d).filter(([, v]) => !Array.isArray(v))), lang));
  }
  const meaning = meaningOf(input.title, input.sub, lang);
  const head = pick(lang, `“${input.title}”${input.sub ? ` — ${input.sub}` : ''}${input.period ? ` (${input.period})` : ''}.`, `«${input.title}»${input.sub ? ` — ${input.sub}` : ''}${input.period ? ` (${input.period})` : ''}.`);
  const body = facts.length ? facts.join(' ') : pick(lang, 'The card carries no figures to read yet.', 'لا تحمل البطاقة أرقاماً للقراءة بعد.');
  const footer = pick(lang, 'Composed from the figures on the screen; nothing is invented.', 'أُلِّف من الأرقام المعروضة على الشاشة؛ ولم يُختلق شيء.');
  const text = [head, body, meaning ?? '', footer].filter(Boolean).join('\n\n');
  const grounding = data === undefined || data === null ? [] : [{ label: input.title, kind: input.kind, text: JSON.stringify(trimRows(data)) }];
  if (input.kind === 'yardstick' || input.kind === 'stat') grounding.push({ label: input.title, kind: input.kind, text: JSON.stringify({ value: input.value ?? null, target: input.target ?? null, unit: input.unit ?? null, sub: input.sub ?? null }) });
  return { text, facts, meaning, grounding };
}
