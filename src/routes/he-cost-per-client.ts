import type { FastifyInstance } from 'fastify'
import { head } from '../ui/theme.js'
import { PLAN_LIMITS } from '../integrations/polar.js'
import { publicRoute } from '../middleware/auth.js'
import { COPY_CSS, COPY_JS, COPY_HASH, copyPill } from '../ui/copy.js'

// The lead magnet for the n8n/Make vertical, in Hebrew.
//
// current-state.md section 8 picked automation agencies as the wedge and put
// the statement in front of the ceiling: "you know what each client costs you",
// with the ceiling as the reason the number holds going forward. This page is
// that sentence addressed to the person who owns the margin.
//
// WHAT IT DELIBERATELY DOES NOT DO. The teardown of the reference asset
// (B-brain/05-research/2026-09-06-adir-salem-lead-magnet-teardown.md) proposed
// shipping a real `GET /statement/:customer_ref` render. That endpoint does not
// exist and the schema holds no price, cost or cents column anywhere: the
// customers table is id, account_id, customer_ref, limit_units, used_units,
// created_at, updated_at. Units only. So this page gives away the MANUAL method
// in full, and every money figure on it is the operator's own arithmetic from
// their own mapping table, stated as such in the frame that carries it.
//
// DARK, not the light treatment the standalone draft used. That draft was a PDF
// replacement and argued for inverting the ground so it read as a document. On
// the site the same choice would be a second brand on one domain, and design.md
// names the genre as dark. Every other rule it states is followed as written:
// logical properties throughout (which is what lets the RTL flip work at all),
// elevation by lightness, one deliberate break, no decorative motion.
//
// The Latin runs are set one step down inside Hebrew body text. Hebrew has a
// tall x-height and no ascenders, so `task_ref` at matched size reads as bold.

const num = (n: number) => n.toLocaleString('en-US')
const free = num(PLAN_LIMITS.free)

/** The sample statement. The remainder is DERIVED, never typed beside the cost. */
const CLIENTS = [
  { name: 'לקוח א', runs: 412, units: 9_860, charged: 1_200 },
  { name: 'לקוח ב', runs: 1_890, units: 61_400, charged: 900 },
  { name: 'לקוח ג', runs: 240, units: 78_200, charged: 700 },
]

// One unit is one agora HERE, because that is the mapping the worked example
// writes down in step 2. It is a decision in a spreadsheet, not a rule the API
// knows about, and the page says so where the number appears.
const ils = (n: number) =>
  '₪' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

function statementRows(): string {
  return CLIENTS.map((c) => {
    const cost = c.units / 100
    const left = c.charged - cost
    const leftTxt = left < 0 ? `(${ils(Math.abs(left))})` : ils(left)
    return `
        <tr>
          <td>${c.name}</td>
          <td class="n">${num(c.runs)}</td>
          <td class="n">${num(c.units)}</td>
          <td class="n money">${ils(cost)}</td>
          <td class="n">${ils(c.charged)}</td>
          <td class="n money${left < 0 ? ' neg' : ''}">${leftTxt}</td>
        </tr>`
  }).join('')
}

const CHECKLIST = [
  'הפרדתי לקוח אחד לוורקפלואו או לתרחיש משלו, או ודאתי שהוא כבר מופרד',
  'משכתי את ההיסטוריה של החודש שעבר, ובדקתי שהיא לא נחתכה ב-250',
  'ספרתי כמה ריצות היו לו. ספרתי, לא הערכתי',
  'כתבתי בטבלה כמה שווה אצלי יחידה אחת, וכתבתי לידה למה',
  'הכפלתי, וקיבלתי שורה אחת: לקוח, ריצות, יחידות, עלות',
  'השוויתי את השורה למה שאני גובה ממנו בפועל',
  'סגרתי את הגיליון, ואמרתי בקול איזה לקוח היה הכי פחות רווחי',
]

const CSS = `
    /* Hallmark · genre: modern-minimal · macrostructure: Long Document, RTL
     * design-system: design.md · nav: none, this is a forwarded asset
     * enrichment: none, the operator's own arithmetic is the panel */

    :root { --shell: 900px; --wide: 1080px;
            --he-display: 'Heebo', 'Assistant', system-ui, sans-serif;
            --he-sans: 'Assistant', 'Heebo', system-ui, sans-serif; }

    body { font-family: var(--he-sans); font-size: var(--fs-body); line-height: 1.85; color: var(--muted); }
    .wrap { max-width: var(--shell); margin: 0 auto; padding-inline: 24px; }
    .wide { max-width: var(--wide); }
    h1, h2, h3 { font-family: var(--he-display); color: var(--white); }
    h1 { font-size: var(--fs-display); line-height: 1.15; letter-spacing: -0.01em; max-width: 17ch; }
    h2 { font-size: var(--fs-h2); margin-bottom: var(--s4); }
    h3 { font-size: var(--fs-h3); margin-bottom: var(--s3); }
    p { margin-bottom: var(--s4); max-width: 58ch; }
    strong { color: var(--text); font-weight: 700; }
    section { padding-block: var(--s8); }
    /* Hebrew has a tall x-height and no ascenders, so an embedded Latin run at a
       matched size reads as if it were bolded. One step down evens them out. */
    .lat { font-size: .94em; }
    code, .mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }

    .kick { padding-block: var(--s7) 0; font-size: var(--fs-small); }
    .kick b { color: var(--green); display: block; font-weight: 600; }
    /* Direct child ONLY. A bare \`.kick span\` also matches the inline .lat runs
       inside the <b>, turns each into a block, and breaks one line into four.
       This is the same defect as the th-that-kept-its-border on /pricing and the
       mask-on-the-framed-element in the docs shell: a structural rule scoped
       wider than the thing it was written for. */
    .kick > span { color: var(--dim); display: block; margin-top: var(--s1); }
    .lede { font-size: var(--fs-lede); color: var(--muted); margin-top: var(--s5); max-width: 54ch; }
    .badge { display: inline-block; font-size: var(--fs-small); font-weight: 600; color: var(--text);
             border: 1px solid var(--border-strong); border-radius: 8px;
             padding: var(--s3) var(--s4); margin-top: var(--s5); line-height: 1.8; }
    .note { border-inline-start: 3px solid var(--border-strong); padding-inline-start: var(--s4);
            color: var(--dim); font-size: var(--fs-small); margin-block: var(--s5); max-width: 56ch; }
    .note strong { color: var(--text); }
    .pull { font-family: var(--he-display); font-size: var(--fs-h3); font-weight: 700; color: var(--white);
            border-inline-start: 4px solid var(--green); padding-inline-start: var(--s4);
            margin-block: var(--s6); max-width: 46ch; line-height: 1.5; }

    /* The three steps, given away above the fold. Source order 1, 2, 3: under
       dir="rtl" the first element renders rightmost, which is where a Hebrew
       reader starts, so no reversal is needed and adding one would re-break it. */
    .steps { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--s4);
             margin-top: var(--s5); }
    .step { background: var(--surface); border: 1px solid var(--border); border-top-color: var(--border2);
            border-radius: 12px; padding: var(--s5); box-shadow: var(--edge), var(--lift); }
    .step b { font-family: var(--mono); font-size: var(--fs-small); color: var(--green);
              display: block; margin-bottom: var(--s3); }
    .step p { margin: 0 0 var(--s2); font-size: var(--fs-small); color: var(--text); }
    .step p:last-child { margin: 0; color: var(--dim); }

    .stepnum { display: flex; align-items: baseline; gap: var(--s3); margin-bottom: var(--s4); }
    .stepnum span { font-family: var(--mono); font-size: var(--fs-h3); font-weight: 700; color: var(--green); }
    .stepnum h2 { margin: 0; }

    /* Every table scrolls itself; the document never scrolls sideways. */
    .tw { overflow-x: auto; margin-block: var(--s5); border: 1px solid var(--border);
          border-top-color: var(--border2); border-radius: 12px; background: var(--surface);
          box-shadow: var(--edge), var(--lift); }
    table { border-collapse: collapse; width: 100%; min-width: 520px; }
    th, td { padding: 12px 16px; text-align: start; border-bottom: 1px solid var(--border-soft);
             font-size: var(--fs-small); }
    thead th { background: var(--surface2); color: var(--dim); font-weight: 500;
               font-size: var(--fs-micro); white-space: nowrap; }
    tbody tr:last-child td { border-bottom: 0; }
    td.n, th.n { font-family: var(--mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
    td.money { color: var(--green); }
    td.neg { color: var(--red); }
    .blank td { height: 30px; }
    .cap { font-size: var(--fs-micro); color: var(--dim); margin-top: calc(var(--s4) * -1);
           margin-bottom: var(--s5); max-width: 64ch; }

    .code { background: var(--bg-deep); border: 1px solid var(--border); border-radius: 12px;
            margin-block: var(--s4); overflow: hidden; }
    .code-h { font-size: var(--fs-micro); color: var(--dim); padding: 10px 16px;
              border-bottom: 1px solid var(--border); background: var(--surface); }
    .code pre { margin: 0; padding: var(--s4) 16px; overflow-x: auto; direction: ltr; text-align: left;
                font-family: var(--mono); font-size: var(--fs-micro); line-height: 1.75; color: var(--code-ink); }
    .code .c { color: var(--dim); }
    .code .s { color: var(--code); }
    .code .f { color: var(--red); font-weight: 700; }

    .limit { background: var(--surface); border: 1px solid var(--border); border-radius: 12px;
             padding: var(--s4) var(--s5); margin-block: var(--s4); font-size: var(--fs-small); color: var(--dim); }
    .limit strong { color: var(--text); }
    .limit .when { display: block; margin-top: var(--s2); font-family: var(--mono);
                   font-size: var(--fs-micro); color: var(--dim); }
    .warn { border-color: var(--fail-line); background: var(--fail-bg); }
    .warn strong { color: var(--red); }

    /* The one deliberate break: the only full-bleed band on the page, and the
       only place it shows the product rather than the method. */
    .band { background: var(--surface); border-block: 1px solid var(--border);
            padding-block: var(--s8); margin-block: var(--s8); }
    .band h2, .band h3 { color: var(--white); }
    .band ul { list-style: none; margin: 0 0 var(--s5); padding: 0; }
    .band li { padding-block: var(--s4); border-bottom: 1px solid var(--border-soft); max-width: 62ch; }
    .band li:last-child { border-bottom: 0; }
    .band li strong { display: block; margin-bottom: var(--s1); }
    .band code { background: var(--surface3); padding: 2px 7px; border-radius: 4px; font-size: .9em; color: var(--code); }

    .check { list-style: none; margin: var(--s5) 0 0; padding: 0; max-width: 62ch; }
    .check li { display: flex; gap: var(--s4); align-items: flex-start; padding-block: var(--s4);
                border-bottom: 1px solid var(--border-soft); color: var(--text); font-size: var(--fs-small); }
    .check li:last-child { border-bottom: 0; }
    /* Drawn, not typed. U+2713 is missing from most Hebrew webfaces and falls
       through to a system UI font, which is the rendered-on-my-machine tell. */
    .check svg { flex: none; margin-top: 3px; color: var(--dim); }

    .close { background: var(--surface); border: 1px solid var(--border); border-top-color: var(--border2);
             border-radius: 12px; padding: var(--s6); margin-top: var(--s5); max-width: 64ch;
             box-shadow: var(--edge), var(--lift); }
    .close p { margin-bottom: var(--s4); }
    .close p:last-child { margin-bottom: 0; }
    .mailto { display: inline-flex; align-items: center; gap: var(--s2); background: var(--green);
              color: var(--green-ink); text-decoration: none; font-weight: 700; font-size: var(--fs-body);
              padding: 12px 20px; border-radius: 8px; min-height: 44px; margin-top: var(--s2); }
    .mailto:hover { filter: brightness(1.06); }
    .mailto:active { transform: translateY(1px); }
    .sub { font-family: var(--mono); font-size: var(--fs-micro); color: var(--dim); margin-top: var(--s3); }

    .foot { border-top: 1px solid var(--border); padding-block: var(--s6) var(--s8); margin-top: var(--s8);
            font-size: var(--fs-micro); color: var(--dim); line-height: 2; }
    .foot b { color: var(--text); }
    .foot a { color: var(--dim); }

    @media (max-width: 720px) {
      .steps { grid-template-columns: minmax(0, 1fr); }
      section { padding-block: var(--s7); }
      .cp { max-width: none; }
    }
`

export async function heCostPerClientRoute(app: FastifyInstance) {
  app.get('/he/cost-per-client', publicRoute(), async (_request, reply) => {
    return reply.type('text/html').send(`${head({
      title: 'כמה כל לקוח עולה לך · AgentBill',
      description: 'שיטה ידנית בת שלושה שלבים למפעילי אוטומציה על n8n ו-Make: להוציא עלות אמיתית לכל לקוח מהנתונים שכבר יושבים אצלך בחשבון. בלי להירשם לכלום.',
      path: '/he/cost-per-client',
      lang: 'he',
      dir: 'rtl',
      og: { description: 'בלי לפתוח גיליון, איזה לקוח היה הכי פחות רווחי אצלך בחודש שעבר? שלושה שלבים, שתי שליפות מוכנות להעתקה, וטבלת מיפוי.' },
      // Hebrew faces, this page only. Every other page loads three Latin faces
      // and has no reason to pay for these.
      extraHead: `  <link href="https://fonts.googleapis.com/css2?family=Heebo:wght@700;800&family=Assistant:wght@400;600;700&display=swap" rel="stylesheet" />`,
      scriptHashes: [COPY_HASH],
      css: `${COPY_CSS}${CSS}`,
    })}
<body>
<main>

  <header class="wrap">
    <div class="kick">
      <b>AgentBill · למפעילי אוטומציה על <span class="lat">n8n</span> ו-<span class="lat">Make</span></b>
      <span>שיטה ידנית. אין פה מה לקנות ואין טופס.</span>
    </div>
    <h1>בלי לפתוח גיליון, איזה לקוח היה הכי פחות רווחי אצלך בחודש שעבר?</h1>
    <p class="lede">בסוף הדף הזה יש לך שורה אחת לכל לקוח: כמה ריצות היו לו, כמה יחידות הוא צרך,
    וכמה זה עלה לך לפי המיפוי שאתה כותב בשלב 2. הכל מנתונים שכבר יושבים אצלך בחשבון.</p>
    <p class="lede">בלי להחליף פלטפורמה. בלי פרוקסי באמצע. בלי להירשם לכלום כדי לקרוא את זה.</p>
    <p class="badge">3 שלבים · 2 שליפות מוכנות להעתקה · טבלת מיפוי אחת, עם דוגמה ממולאת · צ'קליסט של 7 שורות</p>
    <p class="note">אין פה הבטחה של כמה דקות זה ייקח. לא מדדתי את זה על אף מפעיל אחר, אז אין לי
    מספר להגיד. מה שאני כן יכול להגיד זה מה יש בדף, וזה כתוב בשורה שמעל.</p>
  </header>

  <section class="wrap">
    <h2>למה אין לך את המספר הזה</h2>
    <p>אתה מכיר את הרגע.</p>
    <p>בראשון לחודש נכנסה חשבונית אחת מהספק. מספר אחד. מאחוריו אחת עשרה אוטומציות של שישה
    לקוחות, וכולן רצות על אותו מפתח.</p>
    <p>זה לא חוסר סדר שלך. המפתח מונפק מול הספק, וההוצאה נספרת ברמת הפרויקט או הארגון, לחודש.
    אף חוליה בשרשרת לא התבקשה אי פעם לפצל את החשבון לפי לקוח, אז היא לא מפצלת. אפשר לבדוק את
    זה עכשיו: תפתח את הדשבורד של הספק ותנסה לסנן לפי לקוח.</p>
    <p>והתיקון הוא לא גיליון בסוף החודש. בסוף החודש הריצות כבר רצו, אף אחת מהן לא נושאת שם של
    לקוח, ומה שנשאר זה לחלק לפי תחושה.</p>
    <p class="pull">גיליון שמחלק לפי תחושה הוא לא מדידה. הוא ניחוש מסודר.</p>
    <p>מה שכן עובד זה שלושה שלבים, וכולם ידניים.</p>

    <div class="steps">
      <div class="step"><b>1 · לתייג</b>
        <p>שכל ריצה תישא שם של לקוח</p>
        <p>הפלטפורמה כבר שומרת את ההיסטוריה</p></div>
      <div class="step"><b>2 · לתמחר</b>
        <p>להחליט כמה שווה יחידה אחת אצלך</p>
        <p>הצעד היחיד שאף כלי לא יעשה במקומך</p></div>
      <div class="step"><b>3 · לספור</b>
        <p>שורה אחת לכל לקוח: ריצות, יחידות, עלות</p>
        <p>מכפילים את מה שיצא משני השלבים הקודמים</p></div>
    </div>
  </section>

  <section class="wrap">
    <div class="stepnum"><span>1</span><h2>לתייג את הריצה</h2></div>
    <p>לפני שסופרים כסף, צריך שכל ריצה תדע לאיזה לקוח היא שייכת. אם לכל לקוח כבר יש וורקפלואו
    נפרד ב-<span class="lat">n8n</span> או תרחיש נפרד ב-<span class="lat">Make</span>, כבר תייגת
    ואין מה לעשות. אם לא, מפרידים.</p>
    <p><strong>מתחילים משניים עד שלושה לקוחות, לא מכולם.</strong> שניים זה המינימום שנותן השוואה,
    שלושה זה סוף הישיבה הראשונה, וכיסוי מלא זה החודש הבא.</p>
    <p><strong>ב-<span class="lat">n8n</span>.</strong> ההיסטוריה יושבת ב-<span class="lat">Executions</span>,
    ואפשר פשוט להסתכל עליה במסך. אם אתה רוצה לספור בלי לגלול, יש <span class="lat">API</span> ציבורי.
    את השורה הזאת אפשר להדביק בטרמינל, ואפשר לשים את אותה כתובת בתוך
    <span class="lat">HTTP Request node</span> ולהריץ מתוך <span class="lat">n8n</span> עצמו.</p>

    <div class="code">
      <div class="code-h">bash · n8n executions</div>
      <pre><span class="c"># n8n · כל הריצות של וורקפלואו אחד, מ-01.08.2026 והלאה</span>
curl -s "https://YOUR-N8N-HOST/api/v1/executions?workflowId=WORKFLOW_ID&amp;startedAfter=2026-08-01T00:00:00Z&amp;limit=250" \\
  -H "X-N8N-API-KEY: PASTE-YOUR-KEY-HERE"</pre>
    </div>

    <p class="limit"><strong>הגבול של השליפה הזו, כדי שלא תיפול עליה אחר כך.</strong>
    ה-<code>limit</code> המקסימלי הוא 250. אם היו יותר, התשובה מחזירה <code>nextCursor</code>,
    ואתה מריץ שוב עם <code>cursor=</code> והערך הזה. ואם הפעלת מחיקה אוטומטית של היסטוריית ריצות,
    השליפה תחזיר פחות ממה שבאמת רץ, אז תבדוק את ההגדרה הזו לפני שאתה סומך על הספירה.
    <span class="when">נבדק מול התיעוד של n8n ב-06.09.2026</span></p>

    <p><strong>ב-<span class="lat">Make</span>.</strong> אותו דבר, דרך יומני התרחיש.</p>

    <div class="code">
      <div class="code-h">bash · make scenario logs</div>
      <pre><span class="c"># Make · יומני תרחיש אחד. from ו-to הם חותמות זמן במילישניות.</span>
<span class="c"># המספרים כאן הם 01.08.2026 ו-01.09.2026. אם החודש שעבר אצלך אחר, תחליף אותם.</span>
curl -s "https://eu2.make.com/api/v2/scenarios/SCENARIO_ID/logs?from=1785542400000&amp;to=1788220800000&amp;pg[limit]=100" \\
  -H "Authorization: Token PASTE-YOUR-TOKEN-HERE"</pre>
    </div>

    <p class="limit"><strong>הגבול של השליפה הזו.</strong> ה-<code>host</code> תלוי באזור של הארגון
    שלך, <code>eu1</code> או <code>eu2</code> או <code>us1</code> או <code>us2</code>, וזו לא אותה
    כתובת לכולם. ה-<code>token</code> נכתב אחרי המילה <code>Token</code> ובלי <code>Bearer</code>.
    כל שורה ביומן מחזירה <code>operations</code>, <code>transfer</code>, <code>centicredits</code>,
    <code>duration</code>, <code>status</code> ו-<code>timestamp</code>. <code>centicredits</code>
    הן מאיות של קרדיט, אז מחלקים ב-100 לפני שכותבים מספר בגיליון.
    <span class="when">נבדק מול התיעוד של Make ב-06.09.2026</span></p>

    <p class="limit warn"><strong>אזהרה, וכאן המקום שלה.</strong> אל תדביק את המפתחות האלה בצ'אט
    ואל תשמור אותם בגיליון משותף. גם היצוא עצמו הוא לא נתון ניטרלי: יש בו שמות של לקוחות,
    ולפעמים גם תוכן שלהם.</p>

    <p><strong>מה יצא לך מהשלב הזה:</strong> מספר אחד לכל לקוח. כמה ריצות היו לו בחודש שעבר.
    ספירה, לא הערכה.</p>
  </section>

  <section class="wrap wide">
    <div class="stepnum"><span>2</span><h2>להחליט כמה שווה יחידה אחת</h2></div>
    <p>זה השלב שלוקח הכי הרבה זמן, והוא לא טכני. זו החלטה, לא הקלדה. אף כלי לא יעשה אותה
    במקומך, כי היא תלויה במה שסגרת עם הלקוח.</p>
    <p>הבעיה: שני מקורות סופרים שני דברים שונים, ואף אחד מהם לא סופר כסף לפי לקוח.
    <strong>הפלטפורמה</strong> סופרת ריצות ב-<span class="lat">n8n</span> או
    <code>operations</code> ב-<span class="lat">Make</span>, וזה מספר אמיתי בלי מחיר צמוד.
    <strong>הספק</strong> סופר טוקנים, והחשבון שלו הוא לחודש ולמפתח.</p>
    <p>אז מייצרים מטבע אחד באמצע. קוראים לו <strong>יחידה</strong>, וכותבים בטבלה כמה כל דבר
    שווה בה. <strong>תעתיק את הטבלה לגיליון ותמלא בעצמך:</strong></p>

    <div class="tw">
      <table><thead><tr>
        <th>מה נספר</th><th>מי סופר את זה</th><th class="n">כמה יחידות</th>
        <th class="n">כמה זה עולה לי ליחידה</th><th>איך החלטתי</th>
      </tr></thead><tbody>
        <tr class="blank"><td>ריצת <span class="lat">n8n</span></td><td>הפלטפורמה</td><td></td><td></td><td></td></tr>
        <tr class="blank"><td><code>operation</code> ב-<span class="lat">Make</span></td><td>הפלטפורמה</td><td></td><td></td><td></td></tr>
        <tr class="blank"><td>קריאה קצרה למודל</td><td>הספק, בהערכה</td><td></td><td></td><td></td></tr>
        <tr class="blank"><td>קריאה ארוכה למודל</td><td>הספק, בהערכה</td><td></td><td></td><td></td></tr>
        <tr class="blank"><td>שעת עבודה שלי</td><td>אתה</td><td></td><td></td><td></td></tr>
      </tbody></table>
    </div>

    <p><strong>דוגמה ממולאת. המספרים פה הם שלי לצורך ההסבר, לא של אף לקוח אמיתי:</strong></p>
    <div class="tw">
      <table><thead><tr><th>מה נספר</th><th class="n">כמה יחידות</th><th>למה</th></tr></thead><tbody>
        <tr><td>ריצת <span class="lat">n8n</span></td><td class="n">1</td><td>הריצה עצמה כמעט לא עולה, אבל היא הדופק</td></tr>
        <tr><td>קריאה קצרה למודל</td><td class="n">20</td><td>ממוצע גס מהחשבונית של החודש שעבר חלקי מספר הקריאות</td></tr>
        <tr><td>קריאה ארוכה למודל</td><td class="n">140</td><td>סיכום מסמך. מדדתי שלוש כאלה</td></tr>
        <tr><td>שעת עבודה שלי</td><td class="n">12,000</td><td>כי אני מתמחר לעצמי 120 שקל לשעה</td></tr>
      </tbody></table>
    </div>

    <p>אני עובד ביחידות שלמות, ויחידה אחת אצלי היא אגורה אחת. <strong>זו החלטה שלי בגיליון,
    לא כלל של שום כלי.</strong> אפשר להחליט אחרת. מה שחשוב זה להחליט פעם אחת ולכתוב לידה למה,
    כי בעוד חודשיים לא תזכור.</p>
    <p class="note"><strong>ושורה אחת שצריך להגיד בקול:</strong> החלק של הספק בטבלה הזו הוא
    הקצאה, לא מדידה. אתה לוקח מספר אחד אמיתי, החשבונית, ומחלק אותו לפי פרוקסי, מספר הריצות.
    זה מספיק טוב כדי לגלות מי הלקוח שאוכל לך את החודש. זה לא מספיק טוב כדי להתווכח עם לקוח
    על שקל.</p>
  </section>

  <section class="wrap wide">
    <div class="stepnum"><span>3</span><h2>לספור לפי לקוח</h2></div>
    <p>מכפילים את הספירה משלב 1 במיפוי משלב 2. יוצאת שורה אחת לכל לקוח. עמודת העלות היא
    היחידות כפול המיפוי שאתה כתבת, כלומר מספר שאתה ייצרת. אין בשרשרת הזו כלי שיודע להוציא
    אותו במקומך.</p>

    <div class="tw">
      <table><thead><tr>
        <th>לקוח</th><th class="n">ריצות</th><th class="n">יחידות</th>
        <th class="n">עלות מוערכת</th><th class="n">מה גביתי</th><th class="n">מה נשאר</th>
      </tr></thead><tbody>${statementRows()}
      </tbody></table>
    </div>
    <p class="cap">טבלת דוגמה. המספרים מומצאים לצורך ההסבר, והם לא צילום של חשבון אמיתי.
    עמודת "מה נשאר" מחושבת מהשתיים שלפניה ולא נכתבת לידן. סוגריים הם מינוס.</p>

    <p>תסתכל על השורה השלישית. פחות ריצות מכולם, והכי הרבה יחידות. זה מה שהעין לא רואה
    בדשבורד: <strong>מי שרץ הכי הרבה הוא כמעט אף פעם לא מי שעולה הכי הרבה.</strong></p>
    <p class="note"><strong>מה המספר הזה לא.</strong> הוא הערכה שנשענת על המיפוי שכתבת בשלב 2,
    אז הוא טוב כמו הטבלה ההיא ולא יותר. הוא מכסה רק ריצות שנשאו תג של לקוח, והוא לא רואה שום
    דבר שלא תייגת. ועל ריצה שנפלה באמצע הוא לא יודע להגיד כמה היא באמת עלתה.</p>
  </section>

  <div class="band">
    <div class="wrap">
      <h2>איפה השיטה הזו נשברת</h2>
      <p>השיטה למעלה עובדת, והיא עובדת על החודש שעבר. שלושה דברים שוברים אותה:</p>
      <ul>
        <li><strong>היא תמונה, לא מד.</strong> הלולאה שרצה הלילה תיכנס לתמונה בעוד שלושה שבועות,
        כשתשב לעשות את זה שוב.</li>
        <li><strong>כל ריצה שלא תויגה היא בלתי נראית.</strong> ובדיוק אלה הריצות שמפתיעות,
        כי ריצה שהוגדרה בסדר גם מתנהגת בסדר.</li>
        <li><strong>עושים את זה פעם אחת.</strong> אני לא מכיר מפעיל שחזר לזה שלושה חודשים ברצף.</li>
      </ul>

      <h3>מה שבניתי, וגם הוא ביחידות</h3>
      <p>הרעיון לא משתנה. משתנה רק מתי הוא קורה.</p>
      <ul>
        <li><strong><code>customer_id</code> נוסע בכל קריאה.</strong> החלוקה ללקוח קורה בזמן
        הקריאה ונשמרת מול <code>customers.customer_ref</code>. אין מה לשחזר בסוף החודש, כי כלום
        לא אבד באמצע.</li>
        <li><strong><code>task_ref</code> נותן למשימה שלמה תקרה אחת.</strong> קריאה נבדקת מול
        התקרה הזו רק אם היא עצמה קוראת ל-<code>preflight</code> עם אותו <code>task_ref</code>.
        קריאה שלא קוראת, לא נספרת ולא נעצרת.</li>
        <li><strong>התקרה נקבעת בקריאה הראשונה של המשימה.</strong> ערך <code>task_ceiling</code>
        שנשלח אחר כך על אותו <code>task_ref</code> לא משנה אותה.</li>
      </ul>
      <p class="pull">תקציב שמתאפס בראשון לחודש לא עוצר את הלולאה שרצה הלילה.</p>

      <div class="code">
        <div class="code-h">json · POST /preflight · הבקשה</div>
        <pre><span class="c">// דוגמה. שמות השדות מהקוד, המספרים מומצאים לצורך ההסבר.</span>
{
  "agent_id": <span class="s">"lead-enricher"</span>,
  "customer_id": <span class="s">"lavan-studio"</span>,
  "task_ref": <span class="s">"run-2026-09-06-118"</span>,
  "task_ceiling": 500,
  "estimated_units": 120
}</pre>
      </div>

      <div class="code">
        <div class="code-h">json · התשובה על הקריאה החמישית של אותה משימה</div>
        <pre>{
  "approved": <span class="f">false</span>,
  "reason": <span class="f">"task_ceiling_exceeded"</span>,
  "estimated_units": 120,
  "task_ref": <span class="s">"run-2026-09-06-118"</span>,
  "task_ceiling": 500,
  "task_used_units": 480,
  "task_remaining_units": 20
}</pre>
      </div>

      <p>ארבע קריאות של 120 נכנסו, כלומר 480. החמישית ביקשה עוד 120 כשנשארו 20, אז היא לא רצה.</p>

      <h3>ומה שאין, כדי שלא תגלה את זה לבד</h3>
      <ul>
        <li><strong>אין עמודת כסף בסכימה. בכלל.</strong> הטבלה מחזיקה יחידות שלמות. המיפוי
        מיחידה לשקל נשאר בטבלה של שלב 2, אצלך.</li>
        <li><strong>אין <code>endpoint</code> שמוציא חשבונית ללקוח.</strong> זה בתוכנית, זה לא
        בנוי, ואני לא הולך להראות לך מסך של משהו שלא קיים.</li>
        <li><strong>יחידה היא מספר שאתה מגדיר.</strong> אם החלטת שיחידה שווה אגורה, זו שורה
        בקוד שלך. ה-<code>API</code> לא אוכף את זה ולא יודע על זה.</li>
        <li><strong>אני לא יושב בדרך לספק.</strong> אין פרוקסי במסלול הבקשה, ולכן אני גם לא
        רואה כמה הספק חייב אותך. אני רואה רק את מה שדיווחת, ביחידות.</li>
        <li><strong>ועל קריאה שנעצרה, אין לי מושג כמה היא הייתה עולה.</strong> אי אפשר לתמחר
        משהו שלא רץ.</li>
      </ul>
      <p>אם בכל זאת בא לך לנסות את זה על ריצה אחת, הטיר החינמי הוא ${free} קריאות
      <span class="lat">preflight</span> בחודש, בלי כרטיס:</p>
      ${copyPill('install-he', 'pip install agentbill-sdk')}
    </div>
  </div>

  <section class="wrap">
    <h2>צ'קליסט. שבע שורות, על לקוח אחד</h2>
    <ul class="check">${CHECKLIST.map((t) => `
      <li><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4"></rect></svg><span>${t}</span></li>`).join('')}
    </ul>
  </section>

  <section class="wrap">
    <h2>עכשיו תסגור את הדף</h2>
    <div class="close">
      <p>ותגיד בקול: <strong>איזה לקוח היה הכי פחות רווחי אצלך בחודש שעבר?</strong></p>
      <p><strong>ענית בלי להסס?</strong> אז אין לך את הבעיה הזו, וגם אין לי מה למכור לך.
      זה בסדר גמור. תעביר את הדף למישהו שכן.</p>
      <p><strong>נתקעת על השם?</strong> תריץ את שלושת השלבים על לקוח אחד ותשלח לי את השורה
      שיצאה. אני עונה לכל מייל בעצמי.</p>
      <a class="mailto" href="mailto:hello@agentbill.dev?subject=%D7%9C%D7%A7%D7%95%D7%97%20%D7%90%D7%97%D7%93">שלח לי את השורה</a>
      <p class="sub"><span dir="ltr">hello@agentbill.dev</span> · נושא: לקוח אחד</p>
      <p>אין פה טופס, אין רשימת תפוצה ואין מה להירשם אליו. אני רוצה לדעת אם המספר הפתיע אותך,
      כי אם הוא לא הפתיע אף אחד, אין פה מוצר וכדאי לי לדעת את זה מוקדם.</p>
    </div>
  </section>

  <div class="wrap">
    <p class="foot"><b>AgentBill</b> · <a href="/"><span dir="ltr">agentbill.dev</span></a> ·
    תקרה אחת לכל משימה, ביחידות שאתה מגדיר<br>
    הדף הזה יושב ב-<span dir="ltr">agentbill.dev/he/cost-per-client</span>. אם הגיע אליך צילום
    מסך, זו הכתובת.</p>
  </div>

</main>
${COPY_JS}
</body>
</html>
`)
  })
}
