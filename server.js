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

// ========== AUTH ==========
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

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: req.session.user });
});

// ========== DASHBOARD ==========
app.get('/api/dashboard', requireAuth, async (req, res) => {
  try {
    // Récupérer les dates de reset
    const [resets] = await pool.query('SELECT type, date_reset FROM reset_compteurs');
    const resetDepot = resets.find(r => r.type === 'depot');
    const resetRetrait = resets.find(r => r.type === 'retrait');

    // Totaux globaux
    const [allDepots] = await pool.query('SELECT COALESCE(SUM(montant),0) as total FROM depots');
    const [allDepenses] = await pool.query('SELECT COALESCE(SUM(montant),0) as total FROM depenses');
    const [allRetraits] = await pool.query('SELECT COALESCE(SUM(montant),0) as total FROM retraits');

    // Totaux affichés (depuis le dernier reset)
    let totalDepotsAffiche, totalRetraitsAffiche;
    if (resetDepot) {
      const [r] = await pool.query(
        'SELECT COALESCE(SUM(montant),0) as total FROM depots WHERE date_creation > ?',
        [resetDepot.date_reset]
      );
      totalDepotsAffiche = parseFloat(r[0].total);
    } else {
      totalDepotsAffiche = parseFloat(allDepots[0].total);
    }
    if (resetRetrait) {
      const [r] = await pool.query(
        'SELECT COALESCE(SUM(montant),0) as total FROM retraits WHERE date_creation > ?',
        [resetRetrait.date_reset]
      );
      totalRetraitsAffiche = parseFloat(r[0].total);
    } else {
      totalRetraitsAffiche = parseFloat(allRetraits[0].total);
    }

    const solde = parseFloat(allDepots[0].total) - parseFloat(allDepenses[0].total) - parseFloat(allRetraits[0].total);

    res.json({
      solde: solde.toFixed(2),
      totalDepots: totalDepotsAffiche.toFixed(2),
      totalDepenses: parseFloat(allDepenses[0].total).toFixed(2),
      totalRetraits: totalRetraitsAffiche.toFixed(2),
      resetDepotDate: resetDepot ? resetDepot.date_reset : null,
      resetRetraitDate: resetRetrait ? resetRetrait.date_reset : null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ========== RESET COMPTEURS ==========
app.post('/api/reset/:type', requireAuth, async (req, res) => {
  const { type } = req.params;
  if (!['depot', 'retrait'].includes(type)) {
    return res.status(400).json({ error: 'Type invalide (depot ou retrait)' });
  }
  try {
    const now = new Date();
    await pool.query(
      `INSERT INTO reset_compteurs (type, date_reset) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE date_reset = ?`,
      [type, now, now]
    );
    res.json({ success: true, message: `Compteur ${type} réinitialisé`, date: now });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ========== DÉPÔTS ==========
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

// ========== DÉPENSES ==========
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

// ========== RETRAITS ==========
app.post('/api/retraits', requireAuth, async (req, res) => {
  const { montant, mode, nomClient, telephone, codeClient, depositaire, pays } = req.body;
  if (!montant || !mode || !nomClient || !telephone || !codeClient) {
    return res.status(400).json({ error: 'Les champs Montant, Mode, Nom, Téléphone et Code client sont requis' });
  }
  if (!/^[A-Za-z0-9\s\-_.]{1,50}$/.test(codeClient)) {
    return res.status(400).json({
      error: 'Le code client peut contenir lettres, chiffres, espaces, tirets, underscores et points (max 50 caractères)'
    });
  }
  const codeClientUpper = codeClient.toUpperCase().trim();
  const depositaireFinal = depositaire ? depositaire.trim() : 'N/A';
  const paysFinal = pays ? pays.trim() : 'N/A';

  try {
    const idRetrait = `RET-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const [result] = await pool.query(
      `INSERT INTO retraits (montant, mode, nom_client, telephone, id_retrait, code_client, depositaire, pays)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [parseFloat(montant), mode, nomClient, telephone, idRetrait, codeClientUpper, depositaireFinal, paysFinal]
    );
    const [newRetrait] = await pool.query('SELECT * FROM retraits WHERE id = ?', [result.insertId]);
    res.json({ success: true, retrait: newRetrait[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

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

// ========== HISTORIQUE ==========
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

// ========== RAPPORTS ==========
app.get('/api/rapports', requireAuth, async (req, res) => {
  try {
    const [totalDepots] = await pool.query('SELECT COALESCE(SUM(montant),0) as total FROM depots');
    const [totalDepenses] = await pool.query('SELECT COALESCE(SUM(montant),0) as total FROM depenses');
    const [totalRetraits] = await pool.query('SELECT COALESCE(SUM(montant),0) as total FROM retraits');

    const [depotsParMois] = await pool.query(
      `SELECT DATE_FORMAT(date_creation, '%Y-%m') as mois, SUM(montant) as total
       FROM depots GROUP BY DATE_FORMAT(date_creation, '%Y-%m') ORDER BY mois`
    );
    const [depensesParMois] = await pool.query(
      `SELECT DATE_FORMAT(date_creation, '%Y-%m') as mois, SUM(montant) as total
       FROM depenses GROUP BY DATE_FORMAT(date_creation, '%Y-%m') ORDER BY mois`
    );
    const [retraitsParMois] = await pool.query(
      `SELECT DATE_FORMAT(date_creation, '%Y-%m') as mois, SUM(montant) as total
       FROM retraits GROUP BY DATE_FORMAT(date_creation, '%Y-%m') ORDER BY mois`
    );

    res.json({
      totaux: {
        depots: parseFloat(totalDepots[0].total).toFixed(2),
        depenses: parseFloat(totalDepenses[0].total).toFixed(2),
        retraits: parseFloat(totalRetraits[0].total).toFixed(2)
      },
      depotsParMois,
      depensesParMois,
      retraitsParMois
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// ========== DÉMARRAGE ==========
app.listen(PORT, () => {
  console.log(`Serveur lancé sur http://localhost:${PORT}`);
});