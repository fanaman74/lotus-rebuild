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
  const { guests, date, time, firstname, lastname, email, phone, notes, lang } = req.body;

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

  // Send confirmation email
  const subject = {
    en: `Booking confirmed — ${ref}`,
    fr: `Réservation confirmée — ${ref}`,
    nl: `Reservering bevestigd — ${ref}`
  }[lang] || `Booking confirmed — ${ref}`;

  const body = {
    en: `Dear ${firstname},\n\nYour reservation at Lotus has been confirmed.\n\nReference: ${ref}\nGuests: ${guests}\nDate: ${dateFormatted}\nTime: ${time}\n\nIf you need to make changes, please call us at 02 721 98 33.\n\nLotus 荷花\nAv. des Anciens Combattants 81, 1950 Kraainem`,
    fr: `Cher(e) ${firstname},\n\nVotre réservation chez Lotus a été confirmée.\n\nRéférence : ${ref}\nCouverts : ${guests}\nDate : ${dateFormatted}\nHeure : ${time}\n\nPour toute modification, veuillez nous appeler au 02 721 98 33.\n\nLotus 荷花\nAv. des Anciens Combattants 81, 1950 Kraainem`,
    nl: `Beste ${firstname},\n\nUw reservering bij Lotus is bevestigd.\n\nReferentie: ${ref}\nGasten: ${guests}\nDatum: ${dateFormatted}\nTijdstip: ${time}\n\nVoor wijzigingen kunt u ons bereiken op 02 721 98 33.\n\nLotus 荷花\nAv. des Anciens Combattants 81, 1950 Kraainem`
  }[lang] || '';

  try {
    await transporter.sendMail({
      from: `"Lotus Kraainem" <${process.env.GMAIL_USER}>`,
      to: email,
      subject,
      text: body
    });
  } catch (mailErr) {
    console.error('Email failed:', mailErr.message);
    // Don't fail the request — booking is saved, just log the mail error
  }

  res.json({ ref });
});

// ── POST /api/order ───────────────────────────────────────────────────────────
app.post('/api/order', async (req, res) => {
  const { name, email, lang, items } = req.body;

  if (!name || !email || !items || !items.length) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Generate order reference
  const ref = 'ORD-' + crypto.randomBytes(3).toString('hex').toUpperCase();

  // Build item rows
  const itemLines = items.map(item => {
    const qty   = item.qty || 1;
    const price = parseFloat(item.price) || 0;
    const total = (price * qty).toFixed(2);
    return { name: item.name, qty, price: price.toFixed(2), total };
  });
  const grandTotal = itemLines.reduce((sum, i) => sum + parseFloat(i.total), 0).toFixed(2);

  // Build email body per language
  const greetings = {
    en: `Dear ${name},`,
    fr: `Cher(e) ${name},`,
    nl: `Beste ${name},`
  };
  const intros = {
    en: `Thank you so much for your takeaway order at Lotus — we truly appreciate your trust and will have everything ready for you to collect.\n\nBelow is a summary of your order:`,
    fr: `Nous vous remercions chaleureusement pour votre commande à emporter chez Lotus. Votre confiance nous touche et nous préparerons votre commande avec soin.\n\nVoici le récapitulatif de votre commande :`,
    nl: `Hartelijk dank voor uw afhaalbestelling bij Lotus. Wij waarderen uw vertrouwen en zorgen ervoor dat alles klaarstaat wanneer u langskomt.\n\nHieronder vindt u een overzicht van uw bestelling:`
  };
  const tableHeader = {
    en: `  Item                          Qty    Unit     Total`,
    fr: `  Article                       Qté    Unité    Total`,
    nl: `  Artikel                        Aant.  Stuk     Totaal`
  };
  const separator = '  ' + '─'.repeat(52);
  const tableRows = itemLines.map(i => {
    const namePad  = i.name.substring(0, 30).padEnd(30);
    const qtyPad   = String(i.qty).padEnd(6);
    const pricePad = ('€' + i.price).padEnd(8);
    return `  ${namePad} ${qtyPad} ${pricePad} €${i.total}`;
  }).join('\n');
  const totalLines = {
    en: `${separator}\n  ${'TOTAL'.padEnd(38)} €${grandTotal}`,
    fr: `${separator}\n  ${'TOTAL'.padEnd(38)} €${grandTotal}`,
    nl: `${separator}\n  ${'TOTAAL'.padEnd(38)} €${grandTotal}`
  };
  const callToActions = {
    en: `To confirm your takeaway order and arrange collection, please call us at:\n\n  📞  02 721 98 33\n\nOur team will be happy to confirm your collection time, let you know when your order will be ready, and answer any questions you may have.`,
    fr: `Pour confirmer votre commande à emporter et convenir d'un horaire de récupération, veuillez nous appeler au :\n\n  📞  02 721 98 33\n\nNotre équipe se fera un plaisir de confirmer l'heure de retrait, vous indiquer quand votre commande sera prête et répondre à toutes vos questions.`,
    nl: `Om uw afhaalbestelling te bevestigen en een ophaaltijd af te spreken, gelieve ons te bellen op:\n\n  📞  02 721 98 33\n\nOns team bevestigt graag uw ophaaltijdstip, laat u weten wanneer uw bestelling klaar is en beantwoordt al uw vragen.`
  };
  const closings = {
    en: `We look forward to your call and to preparing your meal.\n\nWarm regards,\nThe Lotus Team`,
    fr: `Dans l'attente de votre appel et avec plaisir de préparer votre repas.\n\nL'équipe Lotus`,
    nl: `We kijken uit naar uw telefoontje en bereiden uw maaltijd met plezier.\n\nMet vriendelijke groeten,\nHet Lotus-team`
  };
  const l = ['en', 'fr', 'nl'].includes(lang) ? lang : 'en';

  const body = [
    greetings[l],
    '',
    intros[l],
    '',
    `  ${{ en: 'Takeaway reference', fr: 'Référence de commande', nl: 'Afhaalreferentie' }[l]}: ${ref}`,
    '',
    tableHeader[l],
    tableRows,
    totalLines[l],
    '',
    callToActions[l],
    '',
    closings[l],
    '',
    '─'.repeat(54),
    'Lotus 荷花  |  Av. des Anciens Combattants 81, 1950 Kraainem',
    '02 721 98 33  |  lotuskraainem.be'
  ].join('\n');

  const subjects = {
    en: `Your takeaway order at Lotus — ${ref}`,
    fr: `Votre commande à emporter chez Lotus — ${ref}`,
    nl: `Uw afhaalbestelling bij Lotus — ${ref}`
  };

  try {
    await transporter.sendMail({
      from: `"Lotus Kraainem" <${process.env.GMAIL_USER}>`,
      to: email,
      subject: subjects[l],
      text: body
    });
  } catch (mailErr) {
    console.error('Order email failed:', mailErr.message);
    // Still return the ref — customer has the code even if email failed
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
