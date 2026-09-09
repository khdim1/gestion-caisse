require('dotenv').config();
const express = require('express');
const session = require('express-session');
const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Connexion à MySQL (Aiven)
const pool = mysql.createPool({
  uri: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'secret',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 }
}));

const requireAuth = (req, res, next) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Non authentifié' });
  }
  next();
};

// Servir la page principale
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ========== ROUTES API ==========

// Login
app.post('/api/login', async (req, res) => {
  const { email, motDePasse } = req.body;
  try {
    const [rows] = await pool.query('SELECT * FROM utilisateurs WHERE email = ?', [email]);
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    const valid = await bcrypt.compare(motDePasse, user.mot_de_passe);
    if (!valid) return res.status(401).json({ error: 'Email ou mot de passe incorrect' });
    req.session.user = { id: user.id, email: user.email };
    res.json({ success: true, user: req.session.user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Logout
app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// Vérifier session
app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: req.session.user });
});

// Dashboard
app.get('/api/dashboard', requireAuth, async (req, res) => {
  try {
    const [totalDepots] = await pool.query('SELECT COALESCE(SUM(montant),0) as total FROM depots');
    const [totalDepenses] = await pool.query('SELECT COALESCE(SUM(montant),0) as total FROM depenses');
    const [totalRetraits] = await pool.query('SELECT COALESCE(SUM(montant),0) as total FROM retraits');
    const solde = totalDepots[0].total - totalDepenses[0].total - totalRetraits[0].total;
    res.json({
      solde: parseFloat(solde).toFixed(2),
      totalDepots: parseFloat(totalDepots[0].total).toFixed(2),
      totalDepenses: parseFloat(totalDepenses[0].total).toFixed(2),
      totalRetraits: parseFloat(totalRetraits[0].total).toFixed(2)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Dépôts
app.post('/api/depots', requireAuth, async (req, res) => {
  const { montant, provenance } = req.body;
  if (!montant || !provenance) return res.status(400).json({ error: 'Champs requis' });
  try {
    const [result] = await pool.query(
      'INSERT INTO depots (montant, provenance) VALUES (?, ?)',
      [parseFloat(montant), provenance]
    );
    const [newDepot] = await pool.query('SELECT * FROM depots WHERE id = ?', [result.insertId]);
    res.json({ success: true, depot: newDepot[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Dépenses
app.post('/api/depenses', requireAuth, async (req, res) => {
  const { montant, motif } = req.body;
  if (!montant || !motif) return res.status(400).json({ error: 'Champs requis' });
  try {
    const [result] = await pool.query(
      'INSERT INTO depenses (montant, motif) VALUES (?, ?)',
      [parseFloat(montant), motif]
    );
    const [newDepense] = await pool.query('SELECT * FROM depenses WHERE id = ?', [result.insertId]);
    res.json({ success: true, depense: newDepense[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Retraits (avec code client et génération auto de l'ID)
app.post('/api/retraits', requireAuth, async (req, res) => {
  const { montant, mode, nomClient, telephone, codeClient } = req.body;
  if (!montant || !mode || !nomClient || !telephone || !codeClient) {
    return res.status(400).json({ error: 'Tous les champs sont requis' });
  }
  // Valider codeClient : 4 lettres majuscules
  if (!/^[A-Z]{4}$/.test(codeClient)) {
    return res.status(400).json({ error: 'Le code client doit être 4 lettres majuscules' });
  }
  try {
    const idRetrait = `RET-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const [result] = await pool.query(
      `INSERT INTO retraits (montant, mode, nom_client, telephone, id_retrait, code_client)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [parseFloat(montant), mode, nomClient, telephone, idRetrait, codeClient]
    );
    const [newRetrait] = await pool.query('SELECT * FROM retraits WHERE id = ?', [result.insertId]);
    res.json({ success: true, retrait: newRetrait[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Récupérer un retrait par ID (pour reçu)
app.get('/api/retraits/:id', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM retraits WHERE id = ?', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Retrait introuvable' });
    res.json({ retrait: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Historique (avec guillemets simples)
app.get('/api/historique', requireAuth, async (req, res) => {
  try {
    const [depots] = await pool.query(`SELECT *, 'dépôt' as type FROM depots`);
    const [depenses] = await pool.query(`SELECT *, 'dépense' as type FROM depenses`);
    const [retraits] = await pool.query(`SELECT *, 'retrait' as type FROM retraits`);
    const all = [...depots, ...depenses, ...retraits];
    all.sort((a, b) => new Date(b.date_creation) - new Date(a.date_creation));
    res.json({ historique: all });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

app.listen(PORT, () => {
  console.log(`Serveur lancé sur http://localhost:${PORT}`);
});