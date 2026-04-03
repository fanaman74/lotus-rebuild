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
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY   // service role key — server-side only
);

// ── Nodemailer ────────────────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD   // Gmail App Password (not your login password)
  }
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

// ── GET /api/admin/menu ───────────────────────────────────────────────────────
app.get('/api/admin/menu', adminAuth, async (req, res) => {
  const { data: categories, error: catErr } = await supabase
    .from('menu_categories').select('*').order('sort_order');
  if (catErr) return res.status(500).json({ error: catErr.message });

  const { data: items, error: itemErr } = await supabase
    .from('menu_items').select('*').order('sort_order');
  if (itemErr) return res.status(500).json({ error: itemErr.message });

  res.json({ categories, items });
});

// ── POST /api/admin/categories ────────────────────────────────────────────────
app.post('/api/admin/categories', adminAuth, async (req, res) => {
  const { data, error } = await supabase.from('menu_categories').insert(req.body).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── PUT /api/admin/categories/:id ─────────────────────────────────────────────
app.put('/api/admin/categories/:id', adminAuth, async (req, res) => {
  const { data, error } = await supabase.from('menu_categories')
    .update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── DELETE /api/admin/categories/:id ─────────────────────────────────────────
app.delete('/api/admin/categories/:id', adminAuth, async (req, res) => {
  const { error } = await supabase.from('menu_categories').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── POST /api/admin/items ─────────────────────────────────────────────────────
app.post('/api/admin/items', adminAuth, async (req, res) => {
  const { data, error } = await supabase.from('menu_items').insert(req.body).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── PUT /api/admin/items/:id ──────────────────────────────────────────────────
app.put('/api/admin/items/:id', adminAuth, async (req, res) => {
  const { data, error } = await supabase.from('menu_items')
    .update(req.body).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ── DELETE /api/admin/items/:id ───────────────────────────────────────────────
app.delete('/api/admin/items/:id', adminAuth, async (req, res) => {
  const { error } = await supabase.from('menu_items').delete().eq('id', req.params.id);
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
