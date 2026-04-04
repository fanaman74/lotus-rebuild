require('dotenv').config();
const express = require('express');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── Supabase ──────────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL;

// Public client — uses anon key, RLS filters active items automatically
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhrZGFkdWlteGh6b25kenZxbnd2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUyMzc2NzEsImV4cCI6MjA5MDgxMzY3MX0.tBzetoHvv5VLbA1AXRi4AtG27o4htuZ1ivWnzIYryN4';
const supabase = createClient(SUPABASE_URL, ANON_KEY);

// Admin client — uses service_role key, bypasses RLS for full control
const supabaseAdmin = process.env.SUPABASE_SERVICE_KEY
  ? createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
  : null;

// ── Nodemailer ────────────────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD   // Gmail App Password (not your login password)
  },
  connectionTimeout: 5000,   // 5 s — bail if SMTP unreachable
  greetingTimeout: 5000,
  socketTimeout: 10000
});

// ── GET /api/menu ─────────────────────────────────────────────────────────────
app.get('/api/menu', async (req, res) => {
  const { data: categories, error: catErr } = await supabase
    .from('menu_categories')
    .select('*')
    .order('sort_order');

  if (catErr) return res.status(500).json({ error: catErr.message });

  const { data: items, error: itemErr } = await supabase
    .from('menu_items')
    .select('*')
    .eq('active', true)
    .order('sort_order');

  if (itemErr) return res.status(500).json({ error: itemErr.message });

  const menu = categories.map(cat => ({
    ...cat,
    items: items.filter(i => i.category_slug === cat.slug)
  }));

  res.json(menu);
});

// ── POST /api/book ────────────────────────────────────────────────────────────
app.post('/api/book', async (req, res) => {
  const { guests, date, time, firstname, lastname, email, phone, notes, lang, items } = req.body;

  if (!guests || !date || !time || !firstname || !lastname || !email || !phone) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Generate booking reference
  const ref = 'LTS-' + crypto.randomBytes(3).toString('hex').toUpperCase();

  // Save to Supabase
  const { error: dbErr } = await supabase.from('bookings').insert({
    ref_code: ref, guests, date, time,
    firstname, lastname, email, phone,
    notes: notes || null
  });

  if (dbErr) return res.status(500).json({ error: dbErr.message });

  // Format date nicely
  const locale = lang === 'fr' ? 'fr-BE' : lang === 'nl' ? 'nl-BE' : 'en-GB';
  const dateFormatted = new Date(date + 'T12:00:00').toLocaleDateString(locale, {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  const l = ['en', 'fr', 'nl'].includes(lang) ? lang : 'en';

  const subject = {
    en: `Booking confirmed — ${ref}`,
    fr: `Réservation confirmée — ${ref}`,
    nl: `Reservering bevestigd — ${ref}`
  }[l];

  // Build optional pre-order items table
  let itemsHtml = '';
  if (Array.isArray(items) && items.length) {
    const itemLines = items.map(item => {
      const qty   = item.qty || 1;
      const price = parseFloat(item.price) || 0;
      const total = (price * qty).toFixed(2);
      return `<tr>
        <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;color:#222;font-size:14px;">${item.name}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;color:#666;font-size:14px;text-align:center;">${qty}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;color:#666;font-size:14px;text-align:right;">€${price.toFixed(2)}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #f0f0f0;color:#222;font-size:14px;text-align:right;">€${total}</td>
      </tr>`;
    });
    const grandTotal = items.reduce((s, i) => s + (parseFloat(i.price) || 0) * (i.qty || 1), 0).toFixed(2);
    const headers = { en: ['Item','Qty','Unit price','Total'], fr: ['Article','Qté','Prix unitaire','Total'], nl: ['Artikel','Aant.','Stukprijs','Totaal'] }[l];
    const preorderLabel = { en: 'Pre-selected dishes', fr: 'Plats présélectionnés', nl: 'Voorgeselecteerde gerechten' }[l];
    const totalLabel = { en: 'Total', fr: 'Total', nl: 'Totaal' }[l];
    itemsHtml = `
      <tr><td colspan="2" style="padding:0 0 8px;">
        <p style="margin:0 0 12px;font-size:13px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:#999;">${preorderLabel}</p>
        <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #f0f0f0;border-radius:4px;overflow:hidden;">
          <thead>
            <tr style="background:#f9f9f9;">
              <th style="padding:10px 12px;text-align:left;font-size:11px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:#999;">${headers[0]}</th>
              <th style="padding:10px 12px;text-align:center;font-size:11px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:#999;">${headers[1]}</th>
              <th style="padding:10px 12px;text-align:right;font-size:11px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:#999;">${headers[2]}</th>
              <th style="padding:10px 12px;text-align:right;font-size:11px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:#999;">${headers[3]}</th>
            </tr>
          </thead>
          <tbody>${itemLines.join('')}</tbody>
          <tfoot>
            <tr style="background:#f9f9f9;">
              <td colspan="3" style="padding:12px;font-size:13px;font-weight:700;color:#222;text-align:right;">${totalLabel}</td>
              <td style="padding:12px;font-size:14px;font-weight:700;color:#c8a97e;text-align:right;">€${grandTotal}</td>
            </tr>
          </tfoot>
        </table>
      </td></tr>`;
  }

  const copy = {
    greeting:  { en: `Dear ${firstname},`, fr: `Cher(e) ${firstname},`, nl: `Beste ${firstname},` }[l],
    intro:     { en: 'Your reservation at Lotus has been confirmed. We look forward to welcoming you.', fr: 'Votre réservation chez Lotus a été confirmée. Nous avons hâte de vous accueillir.', nl: 'Uw reservering bij Lotus is bevestigd. We kijken ernaar uit u te verwelkomen.' }[l],
    refLabel:  { en: 'Reference', fr: 'Référence', nl: 'Referentie' }[l],
    guests:    { en: 'Guests', fr: 'Couverts', nl: 'Gasten' }[l],
    date:      { en: 'Date', fr: 'Date', nl: 'Datum' }[l],
    time:      { en: 'Time', fr: 'Heure', nl: 'Tijdstip' }[l],
    changes:   { en: 'Need to make changes? Please call us at 02 721 98 33.', fr: 'Besoin de modifier ? Appelez-nous au 02 721 98 33.', nl: 'Wijzigingen doorgeven? Bel ons op 02 721 98 33.' }[l],
    closing:   { en: 'See you soon,<br>The Lotus Team', fr: 'À très bientôt,<br>L\'équipe Lotus', nl: 'Tot binnenkort,<br>Het Lotus-team' }[l],
  };

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 16px;">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:6px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">

  <!-- Header -->
  <tr><td style="background:#000000;padding:36px 40px;text-align:center;">
    <div style="color:#ffffff;font-size:22px;letter-spacing:6px;font-weight:400;">LOTUS 荷花</div>
    <div style="color:#c8a97e;font-size:11px;letter-spacing:4px;margin-top:6px;text-transform:uppercase;">Kraainem</div>
  </td></tr>

  <!-- Gold bar -->
  <tr><td style="background:#c8a97e;height:3px;line-height:3px;font-size:0;">&nbsp;</td></tr>

  <!-- Body -->
  <tr><td style="padding:40px;">
    <p style="margin:0 0 8px;font-size:13px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:#999;">
      ${subject}
    </p>
    <p style="margin:0 0 28px;font-size:26px;font-weight:700;color:#111;line-height:1.2;">${copy.greeting}</p>
    <p style="margin:0 0 32px;font-size:15px;color:#444;line-height:1.7;">${copy.intro}</p>

    <!-- Booking details box -->
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9f9f9;border-radius:6px;border:1px solid #eeeeee;margin-bottom:32px;">
      <tr>
        <td style="padding:20px 24px;border-bottom:1px solid #eeeeee;">
          <div style="font-size:11px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:#999;margin-bottom:4px;">${copy.refLabel}</div>
          <div style="font-size:18px;font-weight:700;color:#c8a97e;letter-spacing:2px;">${ref}</div>
        </td>
      </tr>
      <tr>
        <td style="padding:0;">
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td style="padding:16px 24px;border-bottom:1px solid #eeeeee;width:50%;">
                <div style="font-size:11px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:#999;margin-bottom:4px;">${copy.guests}</div>
                <div style="font-size:15px;color:#222;font-weight:600;">${guests}</div>
              </td>
              <td style="padding:16px 24px;border-bottom:1px solid #eeeeee;border-left:1px solid #eeeeee;">
                <div style="font-size:11px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:#999;margin-bottom:4px;">${copy.time}</div>
                <div style="font-size:15px;color:#222;font-weight:600;">${time}</div>
              </td>
            </tr>
            <tr>
              <td colspan="2" style="padding:16px 24px;">
                <div style="font-size:11px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:#999;margin-bottom:4px;">${copy.date}</div>
                <div style="font-size:15px;color:#222;font-weight:600;">${dateFormatted}</div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>

    <!-- Optional pre-order items -->
    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:${itemsHtml ? '32px' : '0'};">
      ${itemsHtml}
    </table>

    <!-- Changes note -->
    <p style="margin:0 0 32px;font-size:14px;color:#666;line-height:1.6;border-top:1px solid #eeeeee;padding-top:24px;">${copy.changes}</p>

    <!-- Closing -->
    <p style="margin:0;font-size:14px;color:#444;line-height:1.7;">${copy.closing}</p>
  </td></tr>

  <!-- Footer -->
  <tr><td style="background:#f9f9f9;border-top:1px solid #eeeeee;padding:24px 40px;text-align:center;">
    <p style="margin:0 0 4px;font-size:12px;color:#999;">Av. des Anciens Combattants 81, 1950 Kraainem</p>
    <p style="margin:0;font-size:12px;color:#999;">02 721 98 33</p>
  </td></tr>

</table>
</td></tr></table>
</body></html>`;

  try {
    await transporter.sendMail({
      from: `"Lotus Kraainem" <${process.env.GMAIL_USER}>`,
      to: email,
      subject,
      html,
      text: `${copy.greeting}\n\n${copy.intro}\n\n${copy.refLabel}: ${ref}\n${copy.guests}: ${guests}\n${copy.date}: ${dateFormatted}\n${copy.time}: ${time}\n\n${copy.changes}\n\nLotus 荷花\nAv. des Anciens Combattants 81, 1950 Kraainem`
    });
  } catch (mailErr) {
    console.error('Email failed:', mailErr.message);
  }

  res.json({ ref });
});

// ── POST /api/order ───────────────────────────────────────────────────────────
app.post('/api/order', async (req, res) => {
  const { name, email, lang, items } = req.body;

  if (!name || !email || !items || !items.length) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const ref = 'ORD-' + crypto.randomBytes(3).toString('hex').toUpperCase();
  const l = ['en', 'fr', 'nl'].includes(lang) ? lang : 'en';

  // Build item data
  const itemLines = items.map(item => {
    const qty   = item.qty || 1;
    const price = parseFloat(item.price) || 0;
    const total = (price * qty).toFixed(2);
    return { name: item.name, qty, price: price.toFixed(2), total };
  });
  const grandTotal = itemLines.reduce((s, i) => s + parseFloat(i.total), 0).toFixed(2);

  const copy = {
    subject:  { en: `Your takeaway order at Lotus — ${ref}`, fr: `Votre commande à emporter chez Lotus — ${ref}`, nl: `Uw afhaalbestelling bij Lotus — ${ref}` }[l],
    greeting: { en: `Dear ${name},`, fr: `Cher(e) ${name},`, nl: `Beste ${name},` }[l],
    intro:    { en: 'Thank you for your takeaway order at Lotus. We will have everything freshly prepared and ready for collection — please call us to confirm.', fr: 'Merci pour votre commande à emporter chez Lotus. Nous préparerons tout avec soin et vous attendrons — veuillez nous appeler pour confirmer.', nl: 'Dank u voor uw afhaalbestelling bij Lotus. Alles wordt vers bereid en klaargezet — bel ons om te bevestigen.' }[l],
    refLabel: { en: 'Order reference', fr: 'Référence de commande', nl: 'Afhaalreferentie' }[l],
    colH:     { en: ['Item','Qty','Unit price','Total'], fr: ['Article','Qté','Prix unitaire','Total'], nl: ['Artikel','Aant.','Stukprijs','Totaal'] }[l],
    totalLbl: { en: 'Total', fr: 'Total', nl: 'Totaal' }[l],
    cta:      { en: 'To confirm your order and arrange a collection time, please call us at <strong>02 721 98 33</strong>. Our team will let you know when your meal is ready.', fr: 'Pour confirmer votre commande et convenir d\'une heure de retrait, appelez-nous au <strong>02 721 98 33</strong>. Notre équipe vous dira quand votre repas sera prêt.', nl: 'Om uw bestelling te bevestigen en een ophaaltijd af te spreken, bel ons op <strong>02 721 98 33</strong>. Ons team laat u weten wanneer uw maaltijd klaar is.' }[l],
    closing:  { en: 'We look forward to your call,<br>The Lotus Team', fr: 'Dans l\'attente de votre appel,<br>L\'équipe Lotus', nl: 'We kijken uit naar uw telefoontje,<br>Het Lotus-team' }[l],
  };

  const itemRows = itemLines.map(i => `
    <tr>
      <td style="padding:11px 14px;border-bottom:1px solid #f0f0f0;color:#222;font-size:14px;">${i.name}</td>
      <td style="padding:11px 14px;border-bottom:1px solid #f0f0f0;color:#666;font-size:14px;text-align:center;">${i.qty}</td>
      <td style="padding:11px 14px;border-bottom:1px solid #f0f0f0;color:#666;font-size:14px;text-align:right;">€${i.price}</td>
      <td style="padding:11px 14px;border-bottom:1px solid #f0f0f0;color:#222;font-size:14px;text-align:right;">€${i.total}</td>
    </tr>`).join('');

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:40px 16px;">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:6px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">

  <!-- Header -->
  <tr><td style="background:#000000;padding:36px 40px;text-align:center;">
    <div style="color:#ffffff;font-size:22px;letter-spacing:6px;font-weight:400;">LOTUS 荷花</div>
    <div style="color:#c8a97e;font-size:11px;letter-spacing:4px;margin-top:6px;text-transform:uppercase;">Takeaway · À emporter · Afhaal</div>
  </td></tr>

  <!-- Gold bar -->
  <tr><td style="background:#c8a97e;height:3px;line-height:3px;font-size:0;">&nbsp;</td></tr>

  <!-- Body -->
  <tr><td style="padding:40px;">
    <p style="margin:0 0 28px;font-size:24px;font-weight:700;color:#111;line-height:1.3;">${copy.greeting}</p>
    <p style="margin:0 0 32px;font-size:15px;color:#444;line-height:1.7;">${copy.intro}</p>

    <!-- Reference -->
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9f9f9;border:1px solid #eeeeee;border-radius:6px;margin-bottom:28px;">
      <tr><td style="padding:18px 24px;">
        <div style="font-size:11px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:#999;margin-bottom:6px;">${copy.refLabel}</div>
        <div style="font-size:22px;font-weight:700;color:#c8a97e;letter-spacing:3px;">${ref}</div>
      </td></tr>
    </table>

    <!-- Items table -->
    <table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #eeeeee;border-radius:6px;overflow:hidden;margin-bottom:28px;">
      <thead>
        <tr style="background:#f9f9f9;">
          <th style="padding:10px 14px;text-align:left;font-size:11px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:#999;">${copy.colH[0]}</th>
          <th style="padding:10px 14px;text-align:center;font-size:11px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:#999;">${copy.colH[1]}</th>
          <th style="padding:10px 14px;text-align:right;font-size:11px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:#999;">${copy.colH[2]}</th>
          <th style="padding:10px 14px;text-align:right;font-size:11px;font-weight:600;letter-spacing:1px;text-transform:uppercase;color:#999;">${copy.colH[3]}</th>
        </tr>
      </thead>
      <tbody>${itemRows}</tbody>
      <tfoot>
        <tr style="background:#f9f9f9;">
          <td colspan="3" style="padding:14px;font-size:13px;font-weight:700;color:#222;text-align:right;">${copy.totalLbl}</td>
          <td style="padding:14px;font-size:16px;font-weight:700;color:#c8a97e;text-align:right;">€${grandTotal}</td>
        </tr>
      </tfoot>
    </table>

    <!-- CTA -->
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff8ee;border:1px solid #f0ddb8;border-radius:6px;margin-bottom:32px;">
      <tr><td style="padding:20px 24px;">
        <p style="margin:0;font-size:14px;color:#555;line-height:1.7;">${copy.cta}</p>
      </td></tr>
    </table>

    <!-- Closing -->
    <p style="margin:0;font-size:14px;color:#444;line-height:1.7;">${copy.closing}</p>
  </td></tr>

  <!-- Footer -->
  <tr><td style="background:#f9f9f9;border-top:1px solid #eeeeee;padding:24px 40px;text-align:center;">
    <p style="margin:0 0 4px;font-size:12px;color:#999;">Av. des Anciens Combattants 81, 1950 Kraainem</p>
    <p style="margin:0;font-size:12px;color:#999;">02 721 98 33</p>
  </td></tr>

</table>
</td></tr></table>
</body></html>`;

  const textFallback = [
    copy.greeting, '', copy.intro, '',
    `${copy.refLabel}: ${ref}`, '',
    ...itemLines.map(i => `${i.name}  x${i.qty}  €${i.price}  → €${i.total}`),
    `\n${copy.totalLbl}: €${grandTotal}`, '',
    copy.cta.replace(/<[^>]+>/g, ''), '',
    copy.closing.replace(/<br>/g, '\n'), '',
    'Lotus 荷花 · Av. des Anciens Combattants 81, 1950 Kraainem · 02 721 98 33'
  ].join('\n');

  try {
    await transporter.sendMail({
      from: `"Lotus Kraainem" <${process.env.GMAIL_USER}>`,
      to: email,
      subject: copy.subject,
      html,
      text: textFallback
    });
  } catch (mailErr) {
    console.error('Order email failed:', mailErr.message);
  }

  res.json({ ref });
});

// ── Admin auth middleware ──────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!process.env.ADMIN_PASSWORD || token !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── POST /api/admin/login ─────────────────────────────────────────────────────
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (!process.env.ADMIN_PASSWORD || password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  res.json({ token: process.env.ADMIN_PASSWORD });
});

function requireAdmin(res) {
  if (!supabaseAdmin) {
    res.status(503).json({ error: 'SUPABASE_SERVICE_KEY not configured — admin writes disabled' });
    return false;
  }
  return true;
}

// ── GET /api/admin/menu ───────────────────────────────────────────────────────
app.get('/api/admin/menu', adminAuth, async (req, res) => {
  // Admin menu read needs to see ALL items (including inactive) — use admin client if available
  const db = supabaseAdmin || supabase;
  const { data: categories, error: catErr } = await db
    .from('menu_categories').select('*').order('sort_order');
  if (catErr) return res.status(500).json({ error: catErr.message });

  const { data: items, error: itemErr } = await db
    .from('menu_items').select('*').order('sort_order');
  if (itemErr) return res.status(500).json({ error: itemErr.message });

  res.json({ categories, items });
});

// ── POST /api/admin/categories ────────────────────────────────────────────────
app.post('/api/admin/categories', adminAuth, async (req, res) => {
  if (!requireAdmin(res)) return;
  const { data, error } = await supabaseAdmin.from('menu_categories').insert(req.body).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── PUT /api/admin/categories/:id ─────────────────────────────────────────────
app.put('/api/admin/categories/:id', adminAuth, async (req, res) => {
  if (!requireAdmin(res)) return;
  const { data, error } = await supabaseAdmin.from('menu_categories')
    .update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── DELETE /api/admin/categories/:id ─────────────────────────────────────────
app.delete('/api/admin/categories/:id', adminAuth, async (req, res) => {
  if (!requireAdmin(res)) return;
  const { error } = await supabaseAdmin.from('menu_categories').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── POST /api/admin/items ─────────────────────────────────────────────────────
app.post('/api/admin/items', adminAuth, async (req, res) => {
  if (!requireAdmin(res)) return;
  const { data, error } = await supabaseAdmin.from('menu_items').insert(req.body).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── PUT /api/admin/items/:id ──────────────────────────────────────────────────
app.put('/api/admin/items/:id', adminAuth, async (req, res) => {
  if (!requireAdmin(res)) return;
  const { data, error } = await supabaseAdmin.from('menu_items')
    .update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── DELETE /api/admin/items/:id ───────────────────────────────────────────────
app.delete('/api/admin/items/:id', adminAuth, async (req, res) => {
  if (!requireAdmin(res)) return;
  const { error } = await supabaseAdmin.from('menu_items').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── GET /admin ────────────────────────────────────────────────────────────────
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// ── Fallback: serve index.html for any non-API route ─────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Lotus server running on port ${PORT}`));
