const router = require('express').Router();
const { listTables, getTable, createTable, createPrivateTable, getByCode } = require('../controllers/tablesController');
const { authMiddleware, requireAdmin } = require('../middleware/auth');

router.get('/', listTables);
// Rutas con nombre fijo ANTES de '/:id' para que no las capture
router.get('/by-code/:code', getByCode);
router.post('/private', authMiddleware, createPrivateTable);
router.get('/:id', getTable);
router.post('/', authMiddleware, requireAdmin, createTable);

module.exports = router;
