// routes/companyHouseRoutes.js
const express = require('express');
const { CompanyHouseController } = require('../controllers/CompanyHouse.controller');
const router = express.Router();

// BASE URL: /api/company-house

// Public routes (no auth required)
router.get('/import-progress', CompanyHouseController.getImportProgress);
router.get('/stats', CompanyHouseController.getStats);
router.get('/search', CompanyHouseController.searchCompanies);
router.get('/company/:companyNumber', CompanyHouseController.getCompanyByNumber);
router.get('/paginated', CompanyHouseController.getPaginatedCompanies);

// Protected routes (auth required)
router.post('/import', CompanyHouseController.startImport);
router.post('/stop-import', CompanyHouseController.stopImport);
router.delete('/delete-all', CompanyHouseController.deleteAllData);

module.exports = router;